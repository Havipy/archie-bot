import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { Pinecone, PineconeRecord } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import * as fs from 'fs';
import AppDataSource from '../src/database/persistence/data-source';
import { Namespace } from '../src/database/entities/namespace.entity';
import { NamespaceDocument } from '../src/database/entities/namespace-document.entity';
import { DocumentStatus, AccessMode } from '../src/database/entities/types';
import { mimeFromFilename } from '../src/indexer/mime.util';
import { chunkText } from '../src/indexer/chunk.util';
import { saveDocumentFile } from '../src/storage/storage.util';

const INDEX_NAME = 'faq-knowledge';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-');
}

async function embedText(openai: OpenAI, text: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

async function main() {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  console.log('Connected to DB');

  const namespaceRepo = AppDataSource.getRepository(Namespace);
  const namespaceDocumentRepo = AppDataSource.getRepository(NamespaceDocument);

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  const existingIndexes = await pinecone.listIndexes();
  const indexExists = existingIndexes.indexes?.some((i) => i.name === INDEX_NAME);

  if (!indexExists) {
    console.log(`Creating Pinecone index: ${INDEX_NAME}`);
    await pinecone.createIndex({
      name: INDEX_NAME,
      dimension: 1536,
      metric: 'cosine',
      spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
    });
    console.log('Waiting for index to be ready...');
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }

  const index = pinecone.index(INDEX_NAME);

  const seeds: Array<{ name: string; slug: string; dir: string; accessMode: AccessMode }> = [
    {
      name: 'General',
      slug: 'general',
      dir: path.resolve(__dirname, '../knowledge/general'),
      accessMode: AccessMode.PUBLIC,
    },
    {
      name: 'Project Alpha',
      slug: 'project-alpha',
      dir: path.resolve(__dirname, '../knowledge/project-alpha'),
      accessMode: AccessMode.PUBLIC,
    },
  ];

  for (const seed of seeds) {
    let ns = await namespaceRepo.findOne({ where: { slug: seed.slug } });
    if (!ns) {
      ns = namespaceRepo.create({ name: seed.name, slug: seed.slug, accessMode: seed.accessMode });
      ns = await namespaceRepo.save(ns);
      console.log(`Created namespace: ${ns.name} (${ns.slug}) [${ns.accessMode}]`);
    } else {
      if (ns.accessMode !== seed.accessMode) {
        ns.accessMode = seed.accessMode;
        await namespaceRepo.save(ns);
      }
      console.log(`Namespace exists: ${ns.name} (${ns.slug}) [${ns.accessMode}]`);
    }

    if (!fs.existsSync(seed.dir)) {
      console.log(`Knowledge dir not found: ${seed.dir}, skipping`);
      continue;
    }

    const files = fs
      .readdirSync(seed.dir)
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      .map((f) => path.join(seed.dir, f));

    for (const filePath of files) {
      const filename = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const content = fileBuffer.toString('utf-8');

      let doc = await namespaceDocumentRepo.findOne({ where: { filename, namespaceId: ns.id } });
      const mimeType = mimeFromFilename(filename);
      if (!doc) {
        doc = namespaceDocumentRepo.create({
          filename,
          namespaceId: ns.id,
          uploadedBy: 'seed',
          mimeType,
          status: DocumentStatus.INDEXING,
        });
      } else {
        doc.status = DocumentStatus.INDEXING;
        doc.mimeType = mimeType;
      }
      doc = await namespaceDocumentRepo.save(doc);
      doc.storagePath = saveDocumentFile(doc.id, filename, fileBuffer);
      doc = await namespaceDocumentRepo.save(doc);

      const structured = filename.endsWith('.md');
      const chunks = await chunkText(content, { markdown: structured });
      const pineconeNs = index.namespace(ns.slug);

      const deleteCount = Math.max(doc.chunkCount, chunks.length) + 10;
      try {
        await pineconeNs.deleteMany(
          Array.from({ length: deleteCount }, (_, i) => `${doc.id}-chunk-${i}`),
        );
      } catch {
        /* old vectors may not exist */
      }

      const records: PineconeRecord[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await embedText(openai, chunks[i]);
        records.push({
          id: `${doc.id}-chunk-${i}`,
          values: embedding,
          metadata: { text: chunks[i], filename, namespace: ns.slug, chunkIndex: i, docId: doc.id },
        });
      }

      await pineconeNs.upsert({ records });

      doc.chunkCount = chunks.length;
      doc.status = DocumentStatus.INDEXED;
      await namespaceDocumentRepo.save(doc);

      console.log(`  Indexed ${filename}: ${chunks.length} chunks`);
    }
  }

  await AppDataSource.destroy();
  console.log('\nSeed complete!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
