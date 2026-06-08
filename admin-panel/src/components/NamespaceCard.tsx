'use client';

import Link from 'next/link';
import { Namespace, api } from '@/lib/api';

interface Props {
  namespace: Namespace;
  onDeleted: () => void;
}

export default function NamespaceCard({ namespace, onDeleted }: Props) {
  async function handleDelete() {
    if (!confirm(`Delete namespace "${namespace.name}"? All documents and vectors will be removed.`)) return;
    try {
      await api.namespaces.delete(namespace.id);
      onDeleted();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div className="group rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{namespace.name}</h3>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
                namespace.accessMode === 'public'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
            >
              {namespace.accessMode}
            </span>
          </div>
          <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
            {namespace.slug}
          </span>
          <p className="mt-2 text-xs text-gray-400">
            Created {new Date(namespace.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button
          onClick={handleDelete}
          className="shrink-0 rounded-lg p-1.5 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
          title="Delete namespace"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <Link
        href={`/namespaces/${namespace.id}`}
        className="mt-4 block rounded-lg bg-gray-50 px-4 py-2 text-center text-sm font-medium text-gray-700 transition hover:bg-brand-50 hover:text-brand-600"
      >
        Manage Documents →
      </Link>
    </div>
  );
}
