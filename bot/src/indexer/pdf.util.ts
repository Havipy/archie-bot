import { normalizeWhitespace } from './chunk.util';

/** Fix common PDF text extraction artifacts. */
export function normalizePdfText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n');

  // "Annual\nLeave" → "Annual Leave", but keep paragraph breaks
  text = text.replace(/([a-zа-яё]),?\n([a-zа-яё])/gi, '$1 $2');
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');

  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }

    const isHeading = looksLikePdfHeading(trimmed, current.length === 0);
    if (isHeading && current.length) {
      paragraphs.push(current.join(' '));
      current = [trimmed];
    } else {
      current.push(trimmed);
    }
  }
  if (current.length) paragraphs.push(current.join(' '));

  return normalizeWhitespace(paragraphs.join('\n\n'));
}

/** Heuristic: short ALL CAPS or numbered section titles → markdown ## */
export function pdfTextToStructured(raw: string): string {
  const normalized = normalizePdfText(raw);
  const blocks = normalized.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const line = block.trim();
      if (looksLikePdfHeading(line, true)) {
        const title = line.replace(/^\d+(\.\d+)*[\s.)-]+/, '').trim() || line;
        return `## ${title}\n\n${line === title ? '' : block.replace(line, '').trim()}`.trim();
      }
      return block;
    })
    .filter(Boolean)
    .join('\n\n');
}

function looksLikePdfHeading(line: string, isBlockStart: boolean): boolean {
  if (line.length > 80 || line.length < 3) return false;
  if (/^#{1,6}\s/.test(line)) return false;

  if (/^\d+(\.\d+)*[\s.)-]+[A-ZА-Я]/.test(line) && line.length < 60) return true;
  if (line === line.toUpperCase() && /[A-ZА-Я]/.test(line) && line.length < 50) return true;
  if (isBlockStart && /^[A-ZА-Я][A-Za-zА-Яа-яё\s/-]{2,50}$/.test(line) && !line.endsWith('.')) return true;

  return false;
}
