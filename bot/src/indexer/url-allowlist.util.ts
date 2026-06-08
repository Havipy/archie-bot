import { BadRequestException } from '@nestjs/common';
import { isIP } from 'net';

const ALLOWED_HOST_SUFFIXES = ['.atlassian.net'];

const ALLOWED_HOSTS = new Set(['docs.google.com']);

/** Block private, link-local, metadata and docker-internal targets. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  if (ipVersion === 6) {
    if (host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local
    if (host.startsWith('fe80')) return true; // link-local
    return false;
  }

  return false;
}

function extraAllowlist(): string[] {
  const raw = process.env.INDEX_URL_ALLOWLIST ?? '';
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (isBlockedHost(host)) return false;

  if (ALLOWED_HOSTS.has(host)) return true;
  if (ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  return extraAllowlist().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Reject SSRF targets before indexing a URL. */
export function assertIndexUrlAllowed(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Invalid URL');
  }

  if (url.protocol !== 'https:') {
    throw new BadRequestException('Only HTTPS URLs are allowed');
  }

  if (url.username || url.password) {
    throw new BadRequestException('URLs with credentials are not allowed');
  }

  if (!hostAllowed(url.hostname)) {
    throw new BadRequestException(
      'URL host not allowed. Supported: Confluence (*.atlassian.net), Google Docs (docs.google.com). ' +
        'Set INDEX_URL_ALLOWLIST for extra domains.',
    );
  }

  return url;
}

/** Google Docs/Sheets/Slides only — not arbitrary google.com paths. */
export function assertGoogleIndexPath(url: URL): void {
  if (!url.hostname.endsWith('google.com')) {
    throw new BadRequestException('Invalid Google Docs URL');
  }

  const ok =
    /\/document\/d\//.test(url.pathname) ||
    /\/spreadsheets\/d\//.test(url.pathname) ||
    /\/presentation\/d\//.test(url.pathname);

  if (!ok) {
    throw new BadRequestException('Google URL must be a Docs, Sheets, or Slides link');
  }
}
