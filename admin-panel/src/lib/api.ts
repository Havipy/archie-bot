const API_URL = '/api/proxy';

export type AccessMode = 'public' | 'restricted';

export interface Namespace {
  id: string;
  name: string;
  slug: string;
  accessMode: AccessMode;
  createdAt: string;
}

export type DocumentStatus = 'pending' | 'indexing' | 'indexed' | 'error';

export interface NamespaceDocument {
  id: string;
  filename: string;
  mimeType: string | null;
  namespaceId: string;
  uploadedBy: string;
  uploadedAt: string;
  chunkCount: number;
  status: DocumentStatus;
}

/** @deprecated alias */
export type Document = NamespaceDocument;

export type AccessRuleType = 'email' | 'email_domain' | 'slack_group' | 'slack_channel';

export interface AccessRule {
  id: string;
  namespaceId: string;
  type: AccessRuleType;
  value: string;
  label: string | null;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  namespaces: {
    list: () => request<Namespace[]>('/namespaces'),
    get: (id: string) => request<Namespace>(`/namespaces/${id}`),
    create: (data: { name: string; slug?: string }) =>
      request<Namespace>('/namespaces', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; slug?: string; accessMode?: AccessMode }) =>
      request<Namespace>(`/namespaces/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      fetch(`${API_URL}/namespaces/${id}`, { method: 'DELETE' }).then((r) => {
        if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
      }),
  },
  documents: {
    list: (namespaceId: string) => request<Document[]>(`/namespaces/${namespaceId}/documents`),
    upload: (namespaceId: string, file: File, uploadedBy = 'admin') => {
      const form = new FormData();
      form.append('file', file);
      return fetch(`${API_URL}/namespaces/${namespaceId}/documents?uploadedBy=${uploadedBy}`, {
        method: 'POST',
        body: form,
      }).then((r) => {
        if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
        return r.json() as Promise<Document>;
      });
    },
    uploadBatch: (namespaceId: string, files: File[], uploadedBy = 'admin') => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return fetch(`${API_URL}/namespaces/${namespaceId}/documents/batch?uploadedBy=${uploadedBy}`, {
        method: 'POST',
        body: form,
      }).then((r) => {
        if (!r.ok) throw new Error(`Batch upload failed: ${r.status}`);
        return r.json() as Promise<Document[]>;
      });
    },
    indexUrl: (namespaceId: string, url: string, uploadedBy = 'admin') => {
      const form = new FormData();
      form.append('url', url);
      return fetch(`${API_URL}/namespaces/${namespaceId}/documents?uploadedBy=${uploadedBy}`, {
        method: 'POST',
        body: form,
      }).then((r) => {
        if (!r.ok) throw new Error(`Index URL failed: ${r.status}`);
        return r.json() as Promise<Document>;
      });
    },
    delete: (namespaceId: string, documentId: string) =>
      fetch(`${API_URL}/namespaces/${namespaceId}/documents/${documentId}`, {
        method: 'DELETE',
      }).then((r) => {
        if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
      }),
    deleteBatch: (namespaceId: string, ids: string[]) =>
      request<{ deleted: number }>(`/namespaces/${namespaceId}/documents/batch-delete`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    reindex: (namespaceId: string, documentId: string) =>
      request<Document>(`/namespaces/${namespaceId}/documents/${documentId}/reindex`, {
        method: 'POST',
      }),
    syncConfluence: (
      namespaceId: string,
      data: { spaceKey: string; baseUrl?: string },
      uploadedBy = 'admin',
    ) =>
      request<{
        spaceKey: string;
        baseUrl: string;
        total: number;
        queued: number;
        skipped: number;
        pages: Array<{ title: string; url: string; status: 'queued' | 'skipped' }>;
      }>(`/namespaces/${namespaceId}/sync-confluence?uploadedBy=${uploadedBy}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  access: {
    list: (namespaceId: string) => request<AccessRule[]>(`/namespaces/${namespaceId}/access`),
    add: (namespaceId: string, data: { type: AccessRuleType; value: string; label?: string }) =>
      request<AccessRule>(`/namespaces/${namespaceId}/access`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    remove: (namespaceId: string, ruleId: string) =>
      fetch(`${API_URL}/namespaces/${namespaceId}/access/${ruleId}`, { method: 'DELETE' }).then((r) => {
        if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
      }),
  },
};
