'use client';

import { useEffect, useState } from 'react';
import { Namespace, api } from '@/lib/api';
import NamespaceCard from '@/components/NamespaceCard';
import CreateNamespaceModal from '@/components/CreateNamespaceModal';

export default function HomePage() {
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setNamespaces(await api.namespaces.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load namespaces');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Namespaces</h1>
          <p className="text-sm text-gray-500 mt-1">Knowledge bases for your Slack bot</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition"
        >
          + New Namespace
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      ) : namespaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-16 text-center">
          <p className="text-gray-500">No namespaces yet.</p>
          <button onClick={() => setShowCreate(true)} className="mt-3 text-sm text-brand-500 hover:underline">
            Create your first namespace
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {namespaces.map((ns) => (
            <NamespaceCard key={ns.id} namespace={ns} onDeleted={load} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateNamespaceModal onClose={() => setShowCreate(false)} onCreated={load} />
      )}
    </>
  );
}
