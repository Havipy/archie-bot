/** Append a short id when multiple items share the same filename. */
export function disambiguateFilename<T extends { filename: string; id: string }>(
  item: T,
  items: T[],
  hint?: (item: T) => string,
): string {
  const hasDupes = items.filter((i) => i.filename === item.filename).length > 1;
  if (!hasDupes) return item.filename;
  const suffix = hint?.(item) ?? item.id.slice(0, 8);
  return `${item.filename} · ${suffix}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
