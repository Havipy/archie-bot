'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Namespace, Document, api } from '@/lib/api';
import DocumentList from '@/components/DocumentList';
import UploadModal from '@/components/UploadModal';
import AccessRulesPanel from '@/components/AccessRulesPanel';
import NamespaceSettings from '@/components/NamespaceSettings';

export default function NamespacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [namespace, setNamespace] = useState<Namespace | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [ns, docs] = await Promise.all([api.namespaces.get(id), api.documents.list(id)]);
      setNamespace(ns);
      setDocuments(docs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
  }, [id]);

  const indexing = documents.some((d) => d.status === 'pending' || d.status === 'indexing');
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [id, indexing]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-100" />
        <div className="h-64 animate-pulse rounded-xl bg-gray-100" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
        {error}
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => router.push('/')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{namespace?.name}</h1>
          <p className="text-sm text-gray-400">
            <span className="font-mono">{namespace?.slug}</span>
            {' · '}
            {documents.length} document{documents.length !== 1 ? 's' : ''}
            {indexing && <span className="text-yellow-600"> · indexing…</span>}
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition"
        >
          Upload Document
        </button>
      </div>

      <NamespaceSettings namespace={namespace!} onUpdated={load} />

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Documents</h2>
      </div>

      <DocumentList namespaceId={id} documents={documents} onDeleted={load} />

      <AccessRulesPanel namespace={namespace!} onUpdated={load} />

      {showUpload && (
        <UploadModal
          namespaceId={id}
          onClose={() => setShowUpload(false)}
          onUploaded={load}
        />
      )}
    </>
  );
}
