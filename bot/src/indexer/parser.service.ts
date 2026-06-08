import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as path from 'path';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { htmlToStructuredText } from './html.util';
import { pdfTextToStructured } from './pdf.util';
import { normalizeWhitespace } from './chunk.util';
import { assertGoogleIndexPath, assertIndexUrlAllowed } from './url-allowlist.util';

export interface ParsedContent {
  text: string;
  title: string;
  /** Prefer markdown-style chunking when true. */
  structured: boolean;
}

@Injectable()
export class ParserService {
  private readonly logger = new Logger(ParserService.name);

  async parseBuffer(buffer: Buffer, filename: string): Promise<ParsedContent> {
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.pdf') return this.parsePdf(buffer, filename);
    if (ext === '.docx') return this.parseDocx(buffer, filename);

    const text = normalizeWhitespace(buffer.toString('utf-8'));
    const title = path.basename(filename, ext);
    const structured = ext === '.md';
    return { text, title, structured };
  }

  private async parsePdf(buffer: Buffer, filename: string): Promise<ParsedContent> {
    const parser = new PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      const text = pdfTextToStructured(data.text);
      const title = path.basename(filename, '.pdf');
      this.logger.log(`PDF parsed: ${filename} — ${data.total} pages, ${text.length} chars`);
      return { text, title, structured: true };
    } finally {
      await parser.destroy();
    }
  }

  private async parseDocx(buffer: Buffer, filename: string): Promise<ParsedContent> {
    const html = await mammoth.convertToHtml({ buffer });
    const text = htmlToStructuredText(html.value);
    const title = path.basename(filename, '.docx');
    this.logger.log(`DOCX parsed: ${filename} — ${text.length} chars`);
    return { text, title, structured: true };
  }

  async parseUrl(url: string): Promise<ParsedContent> {
    const parsed = assertIndexUrlAllowed(url);

    const confluence = await this.resolveConfluencePage(parsed.href);
    if (confluence) return this.fetchConfluencePage(confluence.baseUrl, confluence.pageId, parsed.href);

    const gdoc = this.resolveGoogleUrl(parsed.href);
    if (gdoc) return this.parseGoogleDoc(gdoc.exportUrl, gdoc.title);

    throw new BadRequestException(
      'Unsupported URL type. Use Confluence (*.atlassian.net/wiki/...) or Google Docs/Sheets/Slides.',
    );
  }

  private resolveGoogleUrl(
    url: string,
  ): { exportUrl: string; title: string } | null {
    try {
      const u = assertIndexUrlAllowed(url);
      if (!u.hostname.endsWith('google.com')) return null;
      assertGoogleIndexPath(u);

      const docMatch = u.pathname.match(/\/document\/d\/([^/]+)/);
      if (docMatch) {
        return {
          exportUrl: `https://docs.google.com/document/d/${docMatch[1]}/export?format=txt`,
          title: `Google Doc (${docMatch[1].slice(0, 8)}…)`,
        };
      }

      const sheetMatch = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
      if (sheetMatch) {
        const gid = u.hash.match(/gid=(\d+)/)?.[1] ?? '0';
        return {
          exportUrl: `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/export?format=csv&gid=${gid}`,
          title: `Google Sheet (${sheetMatch[1].slice(0, 8)}…)`,
        };
      }

      const slideMatch = u.pathname.match(/\/presentation\/d\/([^/]+)/);
      if (slideMatch) {
        return {
          exportUrl: `https://docs.google.com/presentation/d/${slideMatch[1]}/export?format=txt`,
          title: `Google Slides (${slideMatch[1].slice(0, 8)}…)`,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private async parseGoogleDoc(
    exportUrl: string,
    fallbackTitle: string,
  ): Promise<ParsedContent> {
    this.logger.log(`Fetching Google export: ${exportUrl}`);

    const response = await axios.get<string>(exportUrl, {
      timeout: 20_000,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ArchieBot/1.0; +https://github.com/your-org/faq-bot)',
      },
      responseType: 'text',
    });

    const raw = response.data as string;
    const text = normalizeWhitespace(raw);

    // First non-empty line is often the doc title
    const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim();
    const title =
      firstLine && firstLine.length < 120 ? firstLine : fallbackTitle;

    this.logger.log(
      `Google Doc parsed: "${title}" — ${text.length} chars`,
    );
    return { text, title, structured: true };
  }

  private async resolveConfluencePage(
    url: string,
  ): Promise<{ baseUrl: string; pageId: string } | null> {
    try {
      const u = assertIndexUrlAllowed(url);
      if (!u.hostname.endsWith('.atlassian.net')) return null;
      if (!u.pathname.includes('/wiki')) return null;

      const baseUrl = `${u.protocol}//${u.hostname}`;

      const pagesMatch = u.pathname.match(/\/pages\/(\d+)/);
      if (pagesMatch) {
        return { baseUrl, pageId: pagesMatch[1] };
      }

      const pageId = u.searchParams.get('pageId');
      if (pageId) {
        return { baseUrl, pageId };
      }

      const tinyMatch = u.pathname.match(/\/wiki\/x\/([A-Za-z0-9_-]+)/);
      if (tinyMatch) {
        return this.resolveConfluenceTinyLink(baseUrl, url);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async resolveConfluenceTinyLink(
    baseUrl: string,
    url: string,
  ): Promise<{ baseUrl: string; pageId: string }> {
    const { email, token } = this.confluenceCredentials();

    const response = await axios.get(url, {
      timeout: 20_000,
      maxRedirects: 10,
      auth: { username: email, password: token },
      headers: { Accept: 'text/html' },
      responseType: 'text',
    });

    const finalUrl =
      (response.request as { res?: { responseUrl?: string } })?.res?.responseUrl ?? url;
    const pageId = finalUrl.match(/\/pages\/(\d+)/)?.[1]
      ?? finalUrl.match(/[?&]pageId=(\d+)/)?.[1];

    if (!pageId) {
      throw new BadRequestException(
        `Could not resolve Confluence short link: ${url}`,
      );
    }

    this.logger.log(`Confluence tiny link resolved → page ${pageId}`);
    return { baseUrl, pageId };
  }

  private confluenceCredentials(): { email: string; token: string } {
    const email = process.env.CONFLUENCE_EMAIL ?? process.env.ATLASSIAN_EMAIL;
    const token = process.env.CONFLUENCE_API_TOKEN ?? process.env.ATLASSIAN_API_TOKEN;
    if (!email || !token) {
      throw new BadRequestException(
        'Confluence credentials missing. Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in .env (Atlassian API token from id.atlassian.com).',
      );
    }
    return { email, token };
  }

  private async fetchConfluencePage(
    baseUrl: string,
    pageId: string,
    sourceUrl: string,
  ): Promise<ParsedContent> {
    const { email, token } = this.confluenceCredentials();
    const apiUrl = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.view,title`;

    this.logger.log(`Fetching Confluence page ${pageId}: ${sourceUrl}`);

    try {
      const response = await axios.get<{
        title?: string;
        body?: { view?: { value?: string } };
      }>(apiUrl, {
        timeout: 20_000,
        auth: { username: email, password: token },
        headers: { Accept: 'application/json' },
      });

      const title = response.data.title?.trim() || `Confluence page ${pageId}`;
      const html = response.data.body?.view?.value ?? '';
      if (!html.trim()) {
        throw new BadRequestException(`Confluence page "${title}" has no readable body`);
      }

      const text = htmlToStructuredText(html);
      this.logger.log(`Confluence parsed: "${title}" — ${text.length} chars`);
      return { text, title, structured: true };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;

      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Confluence auth failed. Check CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN and page access.',
        );
      }
      if (status === 404) {
        throw new BadRequestException(`Confluence page ${pageId} not found`);
      }

      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to fetch Confluence page: ${message}`);
    }
  }
}
