import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import OpenAI from 'openai';
import { Repository } from 'typeorm';
import { parseSourceFilename } from '../documents/document-link.util';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { DocumentStatus } from '../database/entities/types';

@Injectable()
export class NamespaceProfileService {
  private readonly logger = new Logger(NamespaceProfileService.name);
  private readonly openai: OpenAI;
  private readonly textCache = new Map<string, { text: string; exp: number }>();
  private readonly vectorCache = new Map<string, { vector: number[]; exp: number }>();
  private static readonly CACHE_TTL = 10 * 60_000;

  constructor(
    @InjectRepository(NamespaceDocument)
    private readonly namespaceDocumentRepo: Repository<NamespaceDocument>,
  ) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }

  /** Router embedding text — built from namespace name + indexed document titles. */
  async profileText(slug: string, displayName: string): Promise<string> {
    const hit = this.textCache.get(slug);
    if (hit && hit.exp > Date.now()) return hit.text;

    const labels = await this.loadDocumentLabels(slug);
    const text = labels.length ? `${displayName}: ${labels.join(', ')}` : displayName;
    this.textCache.set(slug, { text, exp: Date.now() + NamespaceProfileService.CACHE_TTL });
    this.logger.debug(`Profile [${slug}]: ${text.slice(0, 120)}`);
    return text;
  }

  async profileVector(slug: string, displayName: string): Promise<number[]> {
    const hit = this.vectorCache.get(slug);
    if (hit && hit.exp > Date.now()) return hit.vector;

    const text = await this.profileText(slug, displayName);
    const res = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    const vector = res.data[0].embedding;
    this.vectorCache.set(slug, { vector, exp: Date.now() + NamespaceProfileService.CACHE_TTL });
    return vector;
  }

  invalidate(slug?: string): void {
    if (slug) {
      this.textCache.delete(slug);
      this.vectorCache.delete(slug);
      return;
    }
    this.textCache.clear();
    this.vectorCache.clear();
  }

  private async loadDocumentLabels(slug: string): Promise<string[]> {
    const docs = await this.namespaceDocumentRepo.find({
      where: { namespace: { slug }, status: DocumentStatus.INDEXED },
      order: { uploadedAt: 'DESC' },
      take: 15,
    });

    const labels = docs.map((d) => this.labelFromFilename(d.filename)).filter(Boolean);
    return [...new Set(labels)];
  }

  private labelFromFilename(filename: string): string {
    const { label } = parseSourceFilename(filename);
    return label
      .replace(/\.(md|txt|pdf|docx?|html?)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();
  }
}
