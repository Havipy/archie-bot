import { createHmac, timingSafeEqual } from 'crypto';

function secret(): string {
  const value = process.env.ADMIN_SECRET;
  if (!value) {
    throw new Error('ADMIN_SECRET is not configured');
  }
  return value;
}

export function signDocumentLink(docId: string, userId: string): string {
  return createHmac('sha256', secret())
    .update(`${docId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

export function verifyDocumentLink(docId: string, userId: string, sig: string): boolean {
  if (!sig || sig.length !== 16) return false;
  const expected = signDocumentLink(docId, userId);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export function buildDocumentFileUrl(docId: string, userId: string): string | null {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '');
  if (!base) return null;
  const sig = signDocumentLink(docId, userId);
  return `${base}/api/documents/${docId}/file?u=${encodeURIComponent(userId)}&sig=${sig}`;
}

export function fixMojibakeFilename(name: string): string {
  if (!/[ÐÑÃ][\u0080-\u00FF]/.test(name)) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (/[\u0400-\u04FF]/.test(fixed)) return fixed;
  } catch {
    /* keep original */
  }
  return name;
}

function urlSourceLabel(url: string): string {
  try {
    const u = new URL(url);

    if (u.hostname.endsWith('.atlassian.net')) {
      const pageTitle = u.pathname.match(/\/pages\/\d+\/([^/?#]+)/)?.[1];
      if (pageTitle) {
        return decodeURIComponent(pageTitle.replace(/\+/g, ' '));
      }
      return 'Confluence';
    }

    if (u.hostname.includes('google.com')) {
      if (u.pathname.includes('/document/')) return 'Google Doc';
      if (u.pathname.includes('/spreadsheets/')) return 'Google Sheet';
      if (u.pathname.includes('/presentation/')) return 'Google Slides';
    }

    const lastSegment = u.pathname.split('/').filter(Boolean).pop();
    if (lastSegment && lastSegment.length > 2 && lastSegment.length < 80) {
      return decodeURIComponent(lastSegment.replace(/\+/g, ' '));
    }

    return u.hostname;
  } catch {
    return url;
  }
}

export function parseSourceFilename(raw: string): { namespace?: string; label: string; url?: string } {
  let rest = raw;
  let namespace: string | undefined;

  const nsMatch = rest.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (nsMatch) {
    namespace = nsMatch[1];
    rest = nsMatch[2];
  }

  if (rest.startsWith('url:')) {
    const payload = rest.slice(4);
    // url:https://...::v5::Title  (Confluence with version)
    const versionMatch = payload.match(/^(https?:\/\/[^:]+)::v\d+::(.+)$/);
    if (versionMatch) {
      return { namespace, label: versionMatch[2].trim(), url: versionMatch[1] };
    }
    // url:https://...::Title  (plain URL)
    const titleSep = payload.indexOf('::');
    const url = titleSep >= 0 ? payload.slice(0, titleSep) : payload;
    const storedTitle = titleSep >= 0 ? payload.slice(titleSep + 2).trim() : undefined;
    const label = storedTitle || urlSourceLabel(url);
    return { namespace, label, url };
  }

  return { namespace, label: fixMojibakeFilename(rest) };
}

export function formatSourceLine(
  index: number,
  source: { filename: string; docId?: string },
  userId: string,
  options?: { citeIndex?: number },
): string {
  const { label, url } = parseSourceFilename(source.filename);
  const num = options?.citeIndex ?? index + 1;
  const link = url ?? (source.docId ? buildDocumentFileUrl(source.docId, userId) : null);
  const head = link ? `<${link}|${label}>` : `*${label}*`;
  return `${num}. ${head}`;
}

/** User-facing status — embedding scores are low for cross-lingual queries, don't scare users. */
export function answerStatus(sourceCount: number, _topScore: number): string {
  if (sourceCount === 0) return '⚪ *Nothing found*';
  return sourceCount === 1 ? '📎 *1 source*' : `📎 *${sourceCount} sources*`;
}

export function lowMatchHint(_topScore: number): string | null {
  return null;
}
