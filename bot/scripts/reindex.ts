import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { NestFactory } from '@nestjs/core';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { Namespace } from '../src/database/entities/namespace.entity';
import { NamespaceDocument } from '../src/database/entities/namespace-document.entity';
import { IndexerService } from '../src/indexer/indexer.service';
import { RagService } from '../src/rag/rag.service';

function parseStoredUrl(filename: string): string | null {
  if (!filename.startsWith('url:')) return null;
  const payload = filename.slice(4);
  const sep = payload.indexOf('::');
  return sep >= 0 ? payload.slice(0, sep) : payload;
}

async function removeDuplicateUrlDocs(documentRepo: Repository<NamespaceDocument>, namespaceId: string): Promise<number> {
  const docs = await documentRepo.find({ where: { namespaceId }, order: { uploadedAt: 'DESC' } });
  const seen = new Set<string>();
  let removed = 0;

  for (const doc of docs) {
    const url = parseStoredUrl(doc.filename);
    if (!url) continue;
    if (seen.has(url)) {
      await documentRepo.remove(doc);
      removed++;
      console.log(`  🗑  duplicate removed: ${doc.filename}`);
      continue;
    }
    seen.add(url);
  }

  return removed;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });

  const namespaceRepo = app.get<Repository<Namespace>>(getRepositoryToken(Namespace));
  const documentRepo = app.get<Repository<NamespaceDocument>>(getRepositoryToken(NamespaceDocument));
  const indexer = app.get(IndexerService);
  const rag = app.get(RagService);

  const namespaces = await namespaceRepo.find({ order: { createdAt: 'ASC' } });
  console.log(`\n🔄 Full vector reindex — ${namespaces.length} namespace(s)\n`);

  for (const ns of namespaces) {
    console.log(`\n📦 ${ns.name} (${ns.slug})`);

    const dupes = await removeDuplicateUrlDocs(documentRepo, ns.id);
    if (dupes) console.log(`  removed ${dupes} duplicate URL doc(s)`);

    console.log('  wiping Pinecone namespace…');
    await rag.deleteNamespaceVectors(ns.slug);

    const docs = await documentRepo.find({
      where: { namespaceId: ns.id },
      order: { uploadedAt: 'ASC' },
    });

    if (!docs.length) {
      console.log('  (no documents)');
      continue;
    }

    for (const doc of docs) {
      try {
        const updated = await indexer.reindexDocument(doc, ns.slug);
        console.log(`  ✓ ${updated.filename} — ${updated.chunkCount} chunks`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${doc.filename}: ${message}`);
      }
    }
  }

  await app.close();
  console.log('\n✅ Reindex complete\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
