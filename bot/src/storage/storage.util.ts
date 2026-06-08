import * as fs from 'fs';
import * as path from 'path';

export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
}

export function saveDocumentFile(docId: string, filename: string, data: Buffer): string {
  const dir = path.join(uploadsRoot(), docId);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(filename);
  const rel = path.posix.join(docId, safeName);
  fs.writeFileSync(path.join(uploadsRoot(), rel), data);
  return rel;
}

export function readDocumentFile(storagePath: string): Buffer {
  return fs.readFileSync(path.join(uploadsRoot(), storagePath));
}

export function saveLibraryFile(contentHash: string, filename: string, data: Buffer): string {
  const shard = contentHash.slice(0, 2);
  const dir = path.join(uploadsRoot(), 'library', shard, contentHash);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(filename);
  const rel = path.posix.join('library', shard, contentHash, safeName);
  fs.writeFileSync(path.join(uploadsRoot(), rel), data);
  return rel;
}

export function deleteLibraryFile(storagePath: string): void {
  const full = path.join(uploadsRoot(), storagePath);
  const dir = path.dirname(full);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function deleteDocumentFiles(docId: string): void {
  const dir = path.join(uploadsRoot(), docId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
