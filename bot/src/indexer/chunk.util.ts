import {
  MarkdownTextSplitter,
  RecursiveCharacterTextSplitter,
} from '@langchain/textsplitters';

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const MIN_CHUNK = 50;

export interface ChunkOptions {
  /** Treat as markdown. Auto-detected when omitted. */
  markdown?: boolean;
}

let markdownSplitter: MarkdownTextSplitter;
let recursiveSplitter: RecursiveCharacterTextSplitter;

function getMarkdownSplitter(): MarkdownTextSplitter {
  if (!markdownSplitter) {
    markdownSplitter = new MarkdownTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
  }
  return markdownSplitter;
}

function getRecursiveSplitter(): RecursiveCharacterTextSplitter {
  if (!recursiveSplitter) {
    recursiveSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
  }
  return recursiveSplitter;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function chunkText(text: string, options?: ChunkOptions): Promise<string[]> {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const isMarkdown =
    options?.markdown ?? (/^#{1,6}\s/m.test(normalized) || /^-\s/m.test(normalized));

  const splitter = isMarkdown ? getMarkdownSplitter() : getRecursiveSplitter();
  const chunks = await splitter.splitText(normalized);
  return chunks.map((c) => c.trim()).filter((c) => c.length >= MIN_CHUNK);
}
