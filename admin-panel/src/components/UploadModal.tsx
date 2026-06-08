'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Props {
  namespaceId: string;
  onClose: () => void;
  onUploaded: () => void;
}

type Tab = 'file' | 'url' | 'confluence';

const ACCEPTED = '.md,.txt,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 20;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadModal({ namespaceId, onClose, onUploaded }: Props) {
  const [tab, setTab] = useState<Tab>('file');
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState('');
  const [spaceUrl, setSpaceUrl] = useState('');

  function parseConfluenceSpace(url: string): { spaceKey: string; baseUrl: string } | null {
    try {
      const u = new URL(url.trim());
      if (!u.hostname.endsWith('.atlassian.net')) return null;
      const match = u.pathname.match(/\/wiki\/spaces\/([^/]+)/);
      if (!match) return null;
      return { spaceKey: match[1], baseUrl: `${u.protocol}//${u.hostname}` };
    } catch {
      return null;
    }
  }

  const parsedSpace = parseConfluenceSpace(spaceUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(incoming: FileList | File[]) {
    const next = [...files];
    const errors: string[] = [];

    for (const file of Array.from(incoming)) {
      if (next.length >= MAX_FILES) {
        errors.push(`Max ${MAX_FILES} files per batch`);
        break;
      }
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!['pdf', 'md', 'txt', 'docx'].includes(ext)) {
        errors.push(`"${file.name}": unsupported type`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`"${file.name}": over 10MB`);
        continue;
      }
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }

    setFiles(next);
    setError(errors.join(' · '));
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (tab === 'file') {
        if (!files.length) throw new Error('Select at least one file');
        if (files.length === 1) {
          await api.documents.upload(namespaceId, files[0]);
        } else {
          await api.documents.uploadBatch(namespaceId, files);
        }
      } else if (tab === 'url') {
        if (!url.trim()) throw new Error('Enter a URL');
        await api.documents.indexUrl(namespaceId, url.trim());
      } else {
        if (!parsedSpace) throw new Error('Enter a valid Confluence space URL (*.atlassian.net/wiki/spaces/KEY/...)');
        await api.documents.syncConfluence(namespaceId, {
          spaceKey: parsedSpace.spaceKey,
          baseUrl: parsedSpace.baseUrl,
        });
        onUploaded();
        onClose();
        return;
      }
      onUploaded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  const canSubmit =
    tab === 'file' ? files.length > 0 : tab === 'url' ? !!url.trim() : !!parsedSpace;

  const submitLabel =
    tab === 'confluence'
      ? loading
        ? 'Syncing…'
        : 'Sync Space'
      : tab === 'url'
        ? loading
          ? 'Queuing…'
          : 'Index URL'
        : loading
          ? 'Uploading…'
          : files.length > 1
            ? `Upload ${files.length} files`
            : 'Upload';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold">Add to Knowledge Base</h2>
        <p className="mb-4 text-xs text-gray-400">
          Files, URLs, or a full Confluence space. Indexing runs in the background.
        </p>

        <div className="mb-4 flex rounded-lg border border-gray-200 p-1">
          {(
            [
              ['file', 'Upload File'],
              ['url', 'URL'],
              ['confluence', 'Confluence'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${tab === t ? 'bg-brand-500 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {tab === 'file' ? (
            <>
              <div
                className="flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed border-gray-300 p-6 transition hover:border-brand-500 hover:bg-brand-50"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
                }}
              >
                <p className="text-sm font-medium text-gray-700">Click or drop files here</p>
                <p className="mt-1 text-xs text-gray-400">.pdf, .docx, .md, .txt · max 10MB · up to {MAX_FILES} files</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
              {files.length > 0 && (
                <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 text-sm">
                  {files.map((file, i) => (
                    <li key={`${file.name}-${file.size}-${i}`} className="flex items-center justify-between gap-2 px-2 py-1">
                      <span className="truncate font-medium">{file.name}</span>
                      <span className="text-xs text-gray-400">{formatBytes(file.size)}</span>
                      <button type="button" onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : tab === 'url' ? (
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="https://yourorg.atlassian.net/wiki/spaces/..."
              />
              <p className="mt-1 text-xs text-gray-400">Single Confluence or Google Docs page.</p>
            </div>
          ) : (
            <div>
              <input
                type="url"
                value={spaceUrl}
                onChange={(e) => setSpaceUrl(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="https://plus8soft.atlassian.net/wiki/spaces/RY/overview"
              />
              {parsedSpace ? (
                <p className="mt-1 text-xs text-green-600">
                  ✓ Space <strong>{parsedSpace.spaceKey}</strong> · {parsedSpace.baseUrl}
                </p>
              ) : spaceUrl.length > 0 ? (
                <p className="mt-1 text-xs text-red-500">URL must contain /wiki/spaces/KEY/</p>
              ) : (
                <p className="mt-1 text-xs text-gray-400">
                  Paste any page from a Confluence space — all pages will be indexed.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="flex-1 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
