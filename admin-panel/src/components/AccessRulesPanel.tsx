'use client';

import { useEffect, useState } from 'react';
import { AccessMode, AccessRule, AccessRuleType, Namespace, api } from '@/lib/api';

const TYPE_LABELS: Record<AccessRuleType, string> = {
  email: 'Email',
  email_domain: 'Email domain',
  slack_group: 'Slack group',
  slack_channel: 'Slack channel',
};

const TYPE_HINTS: Record<AccessRuleType, string> = {
  email: 'ivan@company.com',
  email_domain: '@company.com',
  slack_group: 'project-alpha-team',
  slack_channel: '#project-alpha (invite bot to private channels first)',
};

interface Props {
  namespace: Namespace;
  onUpdated: () => void;
}

export default function AccessRulesPanel({ namespace, onUpdated }: Props) {
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);

  const [type, setType] = useState<AccessRuleType>('email');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isPublic = namespace.accessMode === 'public';

  async function loadRules() {
    setLoading(true);
    setError('');
    try {
      setRules(await api.access.list(namespace.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access rules');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isPublic) loadRules();
    else {
      setRules([]);
      setLoading(false);
    }
  }, [namespace.id, isPublic]);

  async function handleModeChange(mode: AccessMode) {
    if (mode === namespace.accessMode) return;
    const msg =
      mode === 'public'
        ? 'Switch to Public? All access rules will be removed — everyone in Slack will see this namespace.'
        : 'Switch to Restricted? You will need to add at least one access rule.';
    if (!confirm(msg)) return;

    setModeSaving(true);
    setError('');
    try {
      await api.namespaces.update(namespace.id, { accessMode: mode });
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update access mode');
    } finally {
      setModeSaving(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.access.add(namespace.id, {
        type,
        value: value.trim(),
        label: label.trim() || undefined,
      });
      setShowAdd(false);
      setValue('');
      setLabel('');
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add rule');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(ruleId: string) {
    if (!confirm('Remove this access rule?')) return;
    try {
      await api.access.remove(namespace.id, ruleId);
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Access Control</h2>
          <p className="text-sm text-gray-500">
            {isPublic
              ? '🌐 Public — everyone in Slack can query this namespace'
              : rules.length
                ? `${rules.length} rule${rules.length !== 1 ? 's' : ''} — user must match any (OR)`
                : '🔒 Restricted with no rules — nobody has access'}
          </p>
        </div>
        {!isPublic && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
          >
            + Add Rule
          </button>
        )}
      </div>

      <div className="mb-4 flex rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit">
        {(['public', 'restricted'] as AccessMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={modeSaving}
            onClick={() => handleModeChange(mode)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition ${namespace.accessMode === mode
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
              } disabled:opacity-50`}
          >
            {mode}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
      )}

      {isPublic ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-sm text-green-800">
          All Slack workspace members can search this knowledge base in DM.
          Switch to <strong>Restricted</strong> to limit access by channel, group, or email.
        </div>
      ) : (
        <>
          {showAdd && (
            <form onSubmit={handleAdd} className="mb-4 space-y-3 rounded-xl border border-gray-200 bg-white p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as AccessRuleType)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {(Object.keys(TYPE_LABELS) as AccessRuleType[]).map((t) => (
                      <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Value</label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={TYPE_HINTS[type]}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Label (optional)</label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Display name"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowAdd(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={submitting} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                  {submitting ? 'Adding...' : 'Add'}
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
          ) : rules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-sm text-amber-800">
              🔒 Locked — add at least one rule (channel, group, email, or domain).
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-xs font-medium uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Type</th>
                    <th className="px-4 py-3 text-left">Value</th>
                    <th className="px-4 py-3 text-left">Label</th>
                    <th className="px-4 py-3 text-left">Added</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rules.map((rule) => (
                    <tr key={rule.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                          {TYPE_LABELS[rule.type]}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {rule.type === 'slack_group' || rule.type === 'slack_channel'
                          ? (rule.label ?? rule.value)
                          : rule.value}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{rule.label ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400">{new Date(rule.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDelete(rule.id)}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
