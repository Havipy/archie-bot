'use client';

import { useState } from 'react';
import { Namespace, api } from '@/lib/api';

interface Props {
  namespace: Namespace;
  onUpdated: () => void;
}

export default function NamespaceSettings({ namespace, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(namespace.name);
  const [slug, setSlug] = useState(namespace.slug);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function startEdit() {
    setName(namespace.name);
    setSlug(namespace.slug);
    setError('');
    setEditing(true);
  }

  function cancelEdit() {
    setName(namespace.name);
    setSlug(namespace.slug);
    setError('');
    setEditing(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const nextName = name.trim();
    const nextSlug = slug.trim().toLowerCase();
    if (!nextName || !nextSlug) return;

    setSaving(true);
    setError('');
    try {
      await api.namespaces.update(namespace.id, { name: nextName, slug: nextSlug });
      setEditing(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const slugChanged = slug.trim().toLowerCase() !== namespace.slug;

  return (
    <section className="mb-8 rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Settings</h2>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Display name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Slug</label>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
                required
              />
              <p className="mt-1 text-xs text-gray-400">Shown in Slack footer &amp; base picker</p>
            </div>
          </div>

          {slugChanged && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Slug change affects Slack — users with a pinned base may need to re-select it.
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelEdit} className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !slug.trim()}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-xs text-gray-400">Display name</dt>
            <dd className="font-medium">{namespace.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Slug</dt>
            <dd className="font-mono">{namespace.slug}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
