import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { DocumentStatus } from '../database/entities/types';
import { RagService } from '../rag/rag.service';
import { NamespaceProfileService } from '../rag/namespace-profile.service';
import { ParserService } from './parser.service';
import { chunkText } from './chunk.util';
import { mimeFromFilename } from './mime.util';
import { readDocumentFile, saveDocumentFile } from '../storage/storage.util';

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);

  constructor(
    @InjectRepository(NamespaceDocument)
    private readonly namespaceDocumentRepo: Repository<NamespaceDocument>,
    private readonly ragService: RagService,
    private readonly parserService: ParserService,
    private readonly namespaceProfiles: NamespaceProfileService,
  ) {}

  private async saveAndIndex(
    doc: NamespaceDocument,
    text: string,
    namespace: string,
    structured = false,
  ): Promise<NamespaceDocument> {
    try {
      await this.ragService.deleteDocumentChunks(doc.id, namespace, doc.chunkCount);

      const chunks = await chunkText(text, { markdown: structured });

      const chunkRecords = chunks.map((chunkBody, i) => ({
        id: `${doc.id}-chunk-${i}`,
        text: chunkBody,
        filename: doc.filename,
        chunkIndex: i,
      }));

      await this.ragService.upsertChunks(chunkRecords, namespace);

      doc.chunkCount = chunks.length;
      doc.status = DocumentStatus.INDEXED;
      await this.namespaceDocumentRepo.save(doc);
      this.namespaceProfiles.invalidate(namespace);

      this.logger.log(`Indexed "${doc.filename}": ${chunks.length} chunks`);
    } catch (err) {
      doc.status = DocumentStatus.ERROR;
      await this.namespaceDocumentRepo.save(doc);
      this.logger.error(`Failed to index "${doc.filename}"`, err);
      throw err;
    }

    return doc;
  }

  private upsertNamespaceDocument(
    existing: NamespaceDocument | null,
    fields: Pick<NamespaceDocument, 'filename' | 'namespaceId' | 'uploadedBy' | 'mimeType'>,
  ): NamespaceDocument {
    if (!existing) {
      return this.namespaceDocumentRepo.create({ ...fields, status: DocumentStatus.INDEXING });
    }
    existing.status = DocumentStatus.INDEXING;
    existing.mimeType = fields.mimeType;
    return existing;
  }

  async indexFile(filePath: string, namespaceId: string, slug: string, uploadedBy = 'system'): Promise<NamespaceDocument> {
    const filename = path.basename(filePath);
    const buffer = fs.readFileSync(filePath);
    const mimeType = mimeFromFilename(filename);

    let doc = await this.namespaceDocumentRepo.findOne({ where: { filename, namespaceId } });
    doc = this.upsertNamespaceDocument(doc, { filename, namespaceId, uploadedBy, mimeType });
    doc = await this.namespaceDocumentRepo.save(doc);
    doc.storagePath = saveDocumentFile(doc.id, doc.filename, buffer);
    doc = await this.namespaceDocumentRepo.save(doc);

    const { text, structured } = await this.parserService.parseBuffer(buffer, filename);
    return this.saveAndIndex(doc, text, slug, structured);
  }

  async indexDirectory(dirPath: string, namespaceId: string, slug: string, uploadedBy = 'system'): Promise<void> {
    if (!fs.existsSync(dirPath)) { this.logger.warn(`Not found: ${dirPath}`); return; }

    const supported = ['.md', '.txt', '.pdf', '.docx'];
    const files = fs.readdirSync(dirPath)
      .filter((f) => supported.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(dirPath, f));

    this.logger.log(`Indexing ${files.length} files → "${slug}"`);
    for (const file of files) await this.indexFile(file, namespaceId, slug, uploadedBy);
  }

  async enqueueUploadedBuffer(
    buffer: Buffer,
    filename: string,
    namespaceId: string,
    slug: string,
    uploadedBy: string,
    mimeType?: string,
  ): Promise<NamespaceDocument> {
    const resolvedMime = mimeType ?? mimeFromFilename(filename) ?? null;

    let doc = await this.namespaceDocumentRepo.findOne({ where: { filename, namespaceId } });
    doc = this.upsertNamespaceDocument(doc, { filename, namespaceId, uploadedBy, mimeType: resolvedMime });
    doc = await this.namespaceDocumentRepo.save(doc);

    // Save file to disk before firing background indexing
    doc.storagePath = saveDocumentFile(doc.id, filename, buffer);
    doc = await this.namespaceDocumentRepo.save(doc);

    void this.runStoredFileIndexing(doc.id, slug).catch((err) =>
      this.logger.error(`Background index failed for "${filename}"`, err),
    );

    return doc;
  }

  async findUrlDocument(namespaceId: string, url: string): Promise<NamespaceDocument | null> {
    return this.namespaceDocumentRepo
      .createQueryBuilder('d')
      .where('d.namespaceId = :namespaceId', { namespaceId })
      .andWhere('(d.filename = :exact OR d.filename LIKE :prefix)', {
        exact: `url:${url}`,
        prefix: `url:${url}::%`,
      })
      .getOne();
  }

  parseConfluenceVersion(filename: string): number | null {
    const match = filename.match(/::v(\d+)::/);
    return match ? parseInt(match[1], 10) : null;
  }

  async getConfluencePageVersion(namespaceId: string, url: string): Promise<number | null> {
    const doc = await this.findUrlDocument(namespaceId, url);
    if (!doc || doc.status !== DocumentStatus.INDEXED) return null;
    return this.parseConfluenceVersion(doc.filename);
  }

  async enqueueUrl(
    url: string,
    namespaceId: string,
    slug: string,
    uploadedBy: string,
    options?: { confluenceVersion?: number },
  ): Promise<NamespaceDocument> {
    const versionTag =
      options?.confluenceVersion !== undefined ? `::v${options.confluenceVersion}::` : '::';
    const placeholder = `url:${url}${versionTag}indexing`;
    const mimeType = 'text/html';

    let doc = await this.findUrlDocument(namespaceId, url);
    doc = this.upsertNamespaceDocument(doc, { filename: placeholder, namespaceId, uploadedBy, mimeType });
    doc = await this.namespaceDocumentRepo.save(doc);

    void this.runUrlIndexing(doc.id, url, slug, options?.confluenceVersion).catch((err) =>
      this.logger.error(`Background index failed for URL "${url}"`, err),
    );

    return doc;
  }

  async indexUrl(url: string, namespaceId: string, slug: string, uploadedBy: string): Promise<NamespaceDocument> {
    return this.enqueueUrl(url, namespaceId, slug, uploadedBy);
  }

  private async runStoredFileIndexing(docId: string, slug: string): Promise<void> {
    const doc = await this.namespaceDocumentRepo.findOne({ where: { id: docId } });
    if (!doc?.storagePath) return;

    doc.status = DocumentStatus.INDEXING;
    await this.namespaceDocumentRepo.save(doc);

    const buffer = readDocumentFile(doc.storagePath);
    const { text, structured } = await this.parserService.parseBuffer(buffer, doc.filename);
    await this.saveAndIndex(doc, text, slug, structured);
  }

  private async runUrlIndexing(
    docId: string,
    url: string,
    slug: string,
    confluenceVersion?: number,
  ): Promise<void> {
    const doc = await this.namespaceDocumentRepo.findOne({ where: { id: docId } });
    if (!doc) return;

    doc.status = DocumentStatus.INDEXING;
    await this.namespaceDocumentRepo.save(doc);

    const { text, title, structured } = await this.parserService.parseUrl(url);
    const versionTag = confluenceVersion !== undefined ? `::v${confluenceVersion}::` : '::';
    doc.filename = `url:${url}${versionTag}${title}`;
    await this.namespaceDocumentRepo.save(doc);

    await this.saveAndIndex(doc, `# ${title}\n\n${text}`, slug, structured);
  }

  parseStoredUrl(filename: string): string | null {
    if (!filename.startsWith('url:')) return null;
    const payload = filename.slice(4);
    const versionMatch = payload.match(/^(.*)::v\d+::/);
    if (versionMatch) return versionMatch[1];
    const sep = payload.indexOf('::');
    return sep >= 0 ? payload.slice(0, sep) : payload;
  }

  async reindexDocument(doc: NamespaceDocument, slug: string): Promise<NamespaceDocument> {
    const url = this.parseStoredUrl(doc.filename);
    if (url) {
      return this.indexUrl(url, doc.namespaceId, slug, doc.uploadedBy);
    }

    if (!doc.storagePath) {
      throw new Error(`Namespace document "${doc.filename}" has no stored file`);
    }

    const buffer = readDocumentFile(doc.storagePath);
    const { text, structured } = await this.parserService.parseBuffer(buffer, doc.filename);
    return this.saveAndIndex(doc, text, slug, structured);
  }
}
