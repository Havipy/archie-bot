'use client';

import { useState } from 'react';
import { Document, DocumentStatus, api } from '@/lib/api';

const PAGE_SIZE = 10;

interface DocMeta {
  label: string;
  url?: string;
  badge?: string;
  groupKey: string;
  groupLabel: string;
  /** For Confluence groups: { spaceKey, baseUrl } */
  confluenceRef?: { spaceKey: string; baseUrl: string };
}

function parseDocMeta(filename: string): DocMeta {
  if (!filename.startsWith('url:')) {
    return { label: filename, groupKey: '__files__', groupLabel: 'Uploaded files' };
  }

  const payload = filename.slice(4);
  const versionMatch = payload.match(/^(https?:\/\/[^:]+)::v(\d+)::(.+)$/);
  if (versionMatch) {
    const [, url, version, title] = versionMatch;
    if (url.includes('atlassian.net')) {
      try {
        const u = new URL(url);
        const host = u.hostname.replace('.atlassian.net', '');
        const spaceMatch = u.pathname.match(/\/wiki\/spaces\/([^/]+)/);
        const spaceKey = spaceMatch?.[1] ?? 'unknown';
        const baseUrl = `${u.protocol}//${u.hostname}`;
        return {
          label: title, url, badge: `v${version}`,
          groupKey: `confluence:${host}:${spaceKey}`,
          groupLabel: `Confluence · ${host} / ${spaceKey}`,
          confluenceRef: { spaceKey, baseUrl },
        };
      } catch { /* fall through */ }
    }
    return { label: title, url, groupKey: 'url', groupLabel: 'URLs' };
  }

  const sep = payload.indexOf('::');
  const url = sep >= 0 ? payload.slice(0, sep) : payload;
  const title = sep >= 0 ? payload.slice(sep + 2) : payload;
  const groupLabel = url.includes('google.com') ? 'Google Docs' : 'URLs';
  return { label: title || url, url, groupKey: groupLabel.toLowerCase(), groupLabel };
}

const STATUS_STYLES: Record<DocumentStatus, string> = {
  indexed: 'bg-green-100 text-green-700',
  indexing: 'bg-yellow-100 text-yellow-700',
  pending: 'bg-gray-100 text-gray-600',
  error: 'bg-red-100 text-red-600',
};

interface Props {
  namespaceId: string;
  documents: Document[];
  onDeleted: () => void;
}

export default function DocumentList({ namespaceId, documents, onDeleted }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  // filter by search
  const filtered = search.trim()
    ? documents.filter((d) => {
        const { label } = parseDocMeta(d.filename);
        return label.toLowerCase().includes(search.toLowerCase());
      })
    : documents;

  // group docs
  const groups: { key: string; label: string; docs: Document[]; confluenceRef?: { spaceKey: string; baseUrl: string } }[] = [];
  const groupMap = new Map<string, typeof groups[0]>();

  for (const doc of filtered) {
    const { groupKey, groupLabel, confluenceRef } = parseDocMeta(doc.filename);
    if (!groupMap.has(groupKey)) {
      const g = { key: groupKey, label: groupLabel, docs: [] as Document[], confluenceRef };
      groupMap.set(groupKey, g);
      groups.push(g);
    }
    groupMap.get(groupKey)!.docs.push(doc);
  }

  async function handleDelete(docId: string, label: string) {
    if (!confirm(`Delete "${label}"? Its vectors will also be removed.`)) return;
    try {
      await api.documents.delete(namespaceId, docId);
      onDeleted();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function handleDeleteGroup(groupKey: string, groupLabel: string, docs: Document[]) {
    if (!confirm(`Delete all ${docs.length} documents from "${groupLabel}"?`)) return;
    setDeleting((p) => ({ ...p, [groupKey]: true }));
    try {
      await api.documents.deleteBatch(
        namespaceId,
        docs.map((d) => d.id),
      );
      onDeleted();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setDeleting((p) => ({ ...p, [groupKey]: false }));
    }
  }

  async function handleResync(groupKey: string, confluenceRef: { spaceKey: string; baseUrl: string }) {
    setSyncing((p) => ({ ...p, [groupKey]: true }));
    try {
      await api.documents.syncConfluence(namespaceId, confluenceRef);
      onDeleted();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing((p) => ({ ...p, [groupKey]: false }));
    }
  }

  async function handleReindex(docId: string) {
    try {
      await api.documents.reindex(namespaceId, docId);
      onDeleted();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    }
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400">
        No documents yet. Upload a file or sync a Confluence space to get started.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search documents…"
          className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">×</button>
        )}
      </div>

      {groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
          No documents match "{search}"
        </div>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? (group.docs.length > 5);
        const page = pages[group.key] ?? 0;
        const totalPages = Math.ceil(group.docs.length / PAGE_SIZE);
        const pageDocs = group.docs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        const indexedCount = group.docs.filter((d) => d.status === 'indexed').length;
        const hasError = group.docs.some((d) => d.status === 'error');
        const isIndexing = group.docs.some((d) => d.status === 'indexing' || d.status === 'pending');
        const totalChunks = group.docs.reduce((s, d) => s + d.chunkCount, 0);

        return (
          <div key={group.key} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            {/* Group header */}
            <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-3">
              <button
                onClick={() => setCollapsed((p) => ({ ...p, [group.key]: !isCollapsed }))}
                className="flex flex-1 items-center gap-2 text-left min-w-0"
              >
                <svg className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="truncate font-medium text-sm text-gray-800">{group.label}</span>
                <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                  {group.docs.length}
                </span>
                {isIndexing && <span className="shrink-0 text-xs text-yellow-600">· indexing…</span>}
                {hasError && !isIndexing && <span className="shrink-0 text-xs text-red-500">· errors</span>}
                {!isIndexing && !hasError && (
                  <span className="shrink-0 text-xs text-gray-400">· {indexedCount} indexed · {totalChunks} chunks</span>
                )}
              </button>

              {/* Re-sync for Confluence */}
              {group.confluenceRef && (
                <button
                  disabled={syncing[group.key]}
                  onClick={() => handleResync(group.key, group.confluenceRef!)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-500 disabled:opacity-40"
                  title="Re-sync space (skips unchanged pages)"
                >
                  <svg className={`h-4 w-4 ${syncing[group.key] ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}

              {/* Delete group */}
              <button
                disabled={deleting[group.key]}
                onClick={() => handleDeleteGroup(group.key, group.label, group.docs)}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
                title="Delete all"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>

            {/* Rows */}
            {!isCollapsed && (
              <>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {pageDocs.map((doc) => {
                      const { label, url, badge } = parseDocMeta(doc.filename);
                      return (
                        <tr key={doc.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 font-medium max-w-xs">
                            <div className="flex items-center gap-2">
                              {url ? (
                                <a href={url} target="_blank" rel="noreferrer"
                                  className="truncate text-brand-600 hover:underline" title={label}>
                                  {label}
                                </a>
                              ) : (
                                <span className="truncate" title={label}>{label}</span>
                              )}
                              {badge && (
                                <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 font-mono">{badge}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[doc.status] ?? STATUS_STYLES.pending}`}>
                              {doc.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-400 whitespace-nowrap">{doc.chunkCount} chunks</td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            {(doc.status === 'error' || doc.status === 'indexing') && (
                              <button onClick={() => handleReindex(doc.id)}
                                className="mr-1 rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                                title="Reindex">
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            )}
                            <button onClick={() => handleDelete(doc.id, label)}
                              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                              title="Delete">
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                    <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, group.docs.length)} of {group.docs.length}</span>
                    <div className="flex gap-1">
                      <button
                        disabled={page === 0}
                        onClick={() => setPages((p) => ({ ...p, [group.key]: page - 1 }))}
                        className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30"
                      >←</button>
                      {Array.from({ length: totalPages }, (_, i) => (
                        <button
                          key={i}
                          onClick={() => setPages((p) => ({ ...p, [group.key]: i }))}
                          className={`rounded px-2 py-1 ${i === page ? 'bg-brand-500 text-white' : 'hover:bg-gray-100'}`}
                        >{i + 1}</button>
                      ))}
                      <button
                        disabled={page === totalPages - 1}
                        onClick={() => setPages((p) => ({ ...p, [group.key]: page + 1 }))}
                        className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30"
                      >→</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
