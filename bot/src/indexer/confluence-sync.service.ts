import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { IndexerService } from './indexer.service';

export interface ConfluencePageRef {
  pageId: string;
  title: string;
  url: string;
  version: number;
}

export interface ConfluenceSyncResult {
  spaceKey: string;
  baseUrl: string;
  total: number;
  queued: number;
  skipped: number;
  pages: Array<{ title: string; url: string; status: 'queued' | 'skipped' }>;
}

interface ConfluenceListResponse {
  results?: Array<{
    id: string;
    title?: string;
    version?: { number?: number };
    _links?: { webui?: string };
  }>;
  size?: number;
  limit?: number;
  start?: number;
}

@Injectable()
export class ConfluenceSyncService {
  private readonly logger = new Logger(ConfluenceSyncService.name);

  constructor(private readonly indexerService: IndexerService) {}

  resolveBaseUrl(override?: string): string {
    const raw = override?.trim();
    if (!raw) {
      throw new BadRequestException(
        'Confluence base URL required. Paste a Confluence space URL in the admin panel.',
      );
    }
    const url = new URL(raw);
    if (!url.hostname.endsWith('.atlassian.net')) {
      throw new BadRequestException('Confluence base URL must be *.atlassian.net');
    }
    return `${url.protocol}//${url.hostname}`;
  }

  private credentials(): { email: string; token: string } {
    const email = process.env.CONFLUENCE_EMAIL ?? process.env.ATLASSIAN_EMAIL;
    const token = process.env.CONFLUENCE_API_TOKEN ?? process.env.ATLASSIAN_API_TOKEN;
    if (!email || !token) {
      throw new BadRequestException(
        'Confluence credentials missing. Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in .env.',
      );
    }
    return { email, token };
  }

  async listSpacePages(baseUrl: string, spaceKey: string): Promise<ConfluencePageRef[]> {
    const { email, token } = this.credentials();
    const pages: ConfluencePageRef[] = [];
    const limit = 50;
    let start = 0;

    while (true) {
      const apiUrl = `${baseUrl}/wiki/rest/api/content`;
      const response = await axios.get<ConfluenceListResponse>(apiUrl, {
        params: {
          spaceKey,
          type: 'page',
          status: 'current',
          limit,
          start,
          expand: 'version',
        },
        auth: { username: email, password: token },
        headers: { Accept: 'application/json' },
        timeout: 30_000,
      });

      const batch = response.data.results ?? [];
      for (const page of batch) {
        const webui = page._links?.webui;
        if (!webui) continue;
        pages.push({
          pageId: page.id,
          title: page.title?.trim() || `Page ${page.id}`,
          url: `${baseUrl}/wiki${webui}`,
          version: page.version?.number ?? 0,
        });
      }

      const fetched = batch.length;
      if (fetched < limit) break;
      start += fetched;
      if (start > 5000) {
        this.logger.warn(`Confluence space "${spaceKey}" hit 5000 page safety cap`);
        break;
      }
    }

    return pages;
  }

  async syncSpace(
    namespaceId: string,
    slug: string,
    spaceKey: string,
    uploadedBy: string,
    baseUrlOverride?: string,
  ): Promise<ConfluenceSyncResult> {
    const trimmedKey = spaceKey.trim();
    if (!trimmedKey) throw new BadRequestException('spaceKey is required');

    const baseUrl = this.resolveBaseUrl(baseUrlOverride);
    const pages = await this.listSpacePages(baseUrl, trimmedKey);

    if (!pages.length) {
      throw new BadRequestException(`No pages found in Confluence space "${trimmedKey}"`);
    }

    this.logger.log(`Confluence sync: ${pages.length} pages in "${trimmedKey}" → namespace "${slug}"`);

    const result: ConfluenceSyncResult = {
      spaceKey: trimmedKey,
      baseUrl,
      total: pages.length,
      queued: 0,
      skipped: 0,
      pages: [],
    };

    for (const page of pages) {
      const existingVersion = await this.indexerService.getConfluencePageVersion(namespaceId, page.url);
      if (existingVersion !== null && existingVersion >= page.version) {
        result.skipped += 1;
        result.pages.push({ title: page.title, url: page.url, status: 'skipped' });
        continue;
      }

      await this.indexerService.enqueueUrl(page.url, namespaceId, slug, uploadedBy, {
        confluenceVersion: page.version,
      });
      result.queued += 1;
      result.pages.push({ title: page.title, url: page.url, status: 'queued' });
    }

    return result;
  }
}
