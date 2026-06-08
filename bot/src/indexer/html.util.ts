import * as cheerio from 'cheerio';
import { normalizeWhitespace } from './chunk.util';

const SKIP_SELECTOR = 'script, style, nav, footer, header, aside, iframe, noscript, svg, form';

export function htmlToStructuredText(html: string): string {
  const $ = cheerio.load(html);
  $(SKIP_SELECTOR).remove();

  const root =
    $('main').first().length ? $('main').first()
    : $('article').first().length ? $('article').first()
    : $('[role="main"]').first().length ? $('[role="main"]').first()
    : $('.content, .post-content, .entry-content, #content').first().length
      ? $('.content, .post-content, .entry-content, #content').first()
      : $('body');

  const lines: string[] = [];

  root.find('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th').each((_, el) => {
    const tag = 'tagName' in el ? String(el.tagName).toLowerCase() : '';
    if (!tag) return;
    // Confluence often wraps list item text in nested <p> — skip duplicates
    if (tag === 'p' && $(el).parents('li').length) return;
    const text = $(el).clone().children('ul,ol').remove().end().text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    if (/^h[1-6]$/.test(tag)) {
      lines.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    } else if (tag === 'li') {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  });

  const structured = normalizeWhitespace(lines.join('\n\n'));
  if (structured.length > 100) return structured;

  return normalizeWhitespace(root.text().replace(/\s+/g, ' '));
}
