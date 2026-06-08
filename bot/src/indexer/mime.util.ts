const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_TO_MIME);

export function mimeFromFilename(filename: string): string | null {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()!.toLowerCase()}` : '';
  if (ext === '' && filename.startsWith('url:')) return 'text/html';
  return EXT_TO_MIME[ext] ?? null;
}

export function resolveMimeType(filename: string, provided?: string): string {
  const fromName = mimeFromFilename(filename);
  if (provided && provided !== 'application/octet-stream') return provided;
  return fromName ?? 'application/octet-stream';
}
