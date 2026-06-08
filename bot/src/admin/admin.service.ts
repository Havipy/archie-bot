import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Namespace } from '../database/entities/namespace.entity';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { AccessRule } from '../database/entities/access-rule.entity';
import { AccessMode, DocumentStatus } from '../database/entities/types';
import { ConfluenceSyncService } from '../indexer/confluence-sync.service';
import { IndexerService } from '../indexer/indexer.service';
import { RagService } from '../rag/rag.service';
import { AccessService, AddRuleDto } from '../slack/access.service';
import { SlackService } from '../slack/slack.service';
import { deleteDocumentFiles } from '../storage/storage.util';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

export class CreateNamespaceDto {
  name!: string;
  slug?: string;
}

export class UpdateNamespaceDto {
  name?: string;
  slug?: string;
  accessMode?: AccessMode;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Namespace)
    private readonly namespaceRepo: Repository<Namespace>,
    @InjectRepository(NamespaceDocument)
    private readonly namespaceDocumentRepo: Repository<NamespaceDocument>,
    @InjectRepository(AccessRule)
    private readonly accessRuleRepo: Repository<AccessRule>,
    private readonly indexerService: IndexerService,
    private readonly confluenceSync: ConfluenceSyncService,
    private readonly ragService: RagService,
    private readonly accessService: AccessService,
    private readonly slackService: SlackService,
  ) {}

  async getAllNamespaces(): Promise<Namespace[]> {
    return this.namespaceRepo.find({ order: { createdAt: 'ASC' } });
  }

  async getNamespaceById(id: string): Promise<Namespace> {
    const ns = await this.namespaceRepo.findOne({ where: { id }, relations: ['namespaceDocuments'] });
    if (!ns) throw new NotFoundException(`Namespace ${id} not found`);
    return ns;
  }

  async createNamespace(dto: CreateNamespaceDto): Promise<Namespace> {
    const slug = dto.slug ?? slugify(dto.name);
    const ns = this.namespaceRepo.create({ name: dto.name, slug });
    return this.namespaceRepo.save(ns);
  }

  async updateNamespace(id: string, dto: UpdateNamespaceDto): Promise<Namespace> {
    const ns = await this.getNamespaceById(id);
    if (dto.name !== undefined) ns.name = dto.name;
    if (dto.slug !== undefined) ns.slug = dto.slug;
    if (dto.accessMode !== undefined) {
      ns.accessMode = dto.accessMode;
      if (dto.accessMode === AccessMode.PUBLIC) {
        await this.accessRuleRepo.delete({ namespaceId: id });
      }
    }
    return this.namespaceRepo.save(ns);
  }

  async deleteNamespace(id: string): Promise<void> {
    const ns = await this.getNamespaceById(id);
    await this.ragService.deleteNamespaceVectors(ns.slug);
    await this.namespaceRepo.remove(ns);
  }

  async getDocuments(namespaceId: string): Promise<NamespaceDocument[]> {
    await this.getNamespaceById(namespaceId);
    return this.namespaceDocumentRepo.find({ where: { namespaceId }, order: { uploadedAt: 'DESC' } });
  }

  async uploadDocument(
    namespaceId: string,
    buffer: Buffer,
    filename: string,
    uploadedBy: string,
    mimeType?: string,
  ): Promise<NamespaceDocument> {
    const ns = await this.getNamespaceById(namespaceId);
    return this.indexerService.enqueueUploadedBuffer(
      buffer,
      filename,
      namespaceId,
      ns.slug,
      uploadedBy,
      mimeType,
    );
  }

  async uploadDocuments(
    namespaceId: string,
    files: Array<{ buffer: Buffer; originalname: string; mimetype?: string; size: number }>,
    uploadedBy: string,
  ): Promise<NamespaceDocument[]> {
    const ns = await this.getNamespaceById(namespaceId);
    return Promise.all(
      files.map((file) =>
        this.indexerService.enqueueUploadedBuffer(
          file.buffer,
          file.originalname,
          namespaceId,
          ns.slug,
          uploadedBy,
          file.mimetype,
        ),
      ),
    );
  }

  async indexUrl(namespaceId: string, url: string, uploadedBy: string): Promise<NamespaceDocument> {
    const ns = await this.getNamespaceById(namespaceId);
    return this.indexerService.enqueueUrl(url, namespaceId, ns.slug, uploadedBy);
  }

  async syncConfluenceSpace(
    namespaceId: string,
    spaceKey: string,
    uploadedBy: string,
    baseUrl?: string,
  ): Promise<{ status: 'started'; spaceKey: string; baseUrl: string }> {
    const ns = await this.getNamespaceById(namespaceId);
    const resolvedBase = this.confluenceSync.resolveBaseUrl(baseUrl);

    void this.confluenceSync
      .syncSpace(namespaceId, ns.slug, spaceKey, uploadedBy, baseUrl)
      .then((r) => this.logger.log(`Confluence sync done: ${r.queued} queued, ${r.skipped} skipped in "${spaceKey}"`))
      .catch((err) => this.logger.error(`Confluence sync failed for "${spaceKey}"`, err));

    return { status: 'started', spaceKey, baseUrl: resolvedBase };
  }

  async deleteDocument(namespaceId: string, documentId: string): Promise<void> {
    await this.deleteDocuments(namespaceId, [documentId]);
  }

  async deleteDocuments(namespaceId: string, documentIds: string[]): Promise<{ deleted: number }> {
    const ids = [...new Set(documentIds.filter(Boolean))];
    if (!ids.length) throw new BadRequestException('No document ids provided');

    const ns = await this.getNamespaceById(namespaceId);
    let deleted = 0;

    for (const documentId of ids) {
      const doc = await this.namespaceDocumentRepo.findOne({ where: { id: documentId, namespaceId } });
      if (!doc) continue;
      await this.ragService.deleteDocumentChunks(doc.id, ns.slug, doc.chunkCount);
      deleteDocumentFiles(doc.id);
      await this.namespaceDocumentRepo.remove(doc);
      deleted += 1;
    }

    if (!deleted) throw new NotFoundException('No matching documents found');
    return { deleted };
  }

  /** Manual retry for stuck `indexing` or failed `error` documents. Fire-and-forget. */
  async reindexDocument(namespaceId: string, documentId: string): Promise<NamespaceDocument> {
    const doc = await this.namespaceDocumentRepo.findOne({ where: { id: documentId, namespaceId } });
    if (!doc) throw new NotFoundException(`Namespace document ${documentId} not found`);
    const ns = await this.getNamespaceById(namespaceId);

    doc.status = DocumentStatus.INDEXING;
    await this.namespaceDocumentRepo.save(doc);

    void this.indexerService.reindexDocument(doc, ns.slug).catch(async (err) => {
      this.logger.error(`Reindex failed for "${doc.filename}"`, err);
      doc.status = DocumentStatus.ERROR;
      await this.namespaceDocumentRepo.save(doc);
    });

    return doc;
  }

  async getAccessRules(namespaceId: string) {
    return this.accessService.getRules(namespaceId);
  }

  async addAccessRule(namespaceId: string, dto: AddRuleDto) {
    const ns = await this.getNamespaceById(namespaceId);
    if (ns.accessMode === AccessMode.PUBLIC) {
      throw new BadRequestException('Public namespace has no access rules. Switch to Restricted first.');
    }
    return this.accessService.addRule(namespaceId, dto, this.slackService.app);
  }

  async removeAccessRule(namespaceId: string, ruleId: string) {
    return this.accessService.removeRule(namespaceId, ruleId);
  }
}
