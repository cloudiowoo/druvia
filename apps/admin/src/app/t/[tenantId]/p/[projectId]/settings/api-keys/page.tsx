'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import type { TrustedBackendKeyScope } from '@/lib/api';

interface ApiKey {
  id: number;
  projectId: string;
  keyPrefix: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface NewKeyResult {
  key: string;
  apiKey: ApiKey;
}

interface TrustedBackendKey {
  id: number;
  projectId: string;
  keyPrefix: string;
  name: string | null;
  scopes: TrustedBackendKeyScope[];
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface NewTrustedBackendKeyResult {
  key: string;
  trustedBackendKey: TrustedBackendKey;
}

const TRUSTED_BACKEND_SCOPE_OPTIONS: Array<{ value: TrustedBackendKeyScope; label: string; description: string }> = [
  {
    value: 'project_session:issue',
    label: 'Project Session',
    description: '允许为已有业务用户签发标准 project session',
  },
  {
    value: 'storage_ticket:issue',
    label: 'Storage Ticket',
    description: '允许签发受限的 storage upload/remove ticket',
  },
];

export default function ApiKeysPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [trustedKeys, setTrustedKeys] = useState<TrustedBackendKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingTrustedKey, setCreatingTrustedKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newTrustedKeyName, setNewTrustedKeyName] = useState('');
  const [trustedKeyScopes, setTrustedKeyScopes] = useState<TrustedBackendKeyScope[]>([
    'project_session:issue',
    'storage_ticket:issue',
  ]);
  const [newKey, setNewKey] = useState<NewKeyResult | null>(null);
  const [newTrustedKey, setNewTrustedKey] = useState<NewTrustedBackendKeyResult | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showTrustedCreateForm, setShowTrustedCreateForm] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deletingTrustedId, setDeletingTrustedId] = useState<number | null>(null);

  useEffect(() => {
    fetchKeys();
  }, [projectId]);

  async function fetchKeys() {
    setLoading(true);
    const [apiKeysRes, trustedKeysRes] = await Promise.all([
      api.listApiKeys(projectId),
      api.listTrustedBackendKeys(projectId),
    ]);
    if (apiKeysRes.success && apiKeysRes.data) {
      setKeys(apiKeysRes.data);
    }
    if (trustedKeysRes.success && trustedKeysRes.data) {
      setTrustedKeys(trustedKeysRes.data);
    }
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await api.createApiKey(projectId, newKeyName || undefined);
    if (res.success && res.data) {
      setNewKey(res.data);
      setKeys((prev) => [res.data!.apiKey, ...prev]);
      setNewKeyName('');
      setShowCreateForm(false);
    }
    setCreating(false);
  }

  async function handleDelete(id: number) {
    if (!confirm('确定要删除此 API Key 吗？此操作不可恢复。')) return;
    setDeletingId(id);
    const res = await api.deleteApiKey(projectId, id);
    if (res.success) {
      setKeys((prev) => prev.filter((k) => k.id !== id));
    }
    setDeletingId(null);
  }

  async function handleCreateTrustedKey(e: React.FormEvent) {
    e.preventDefault();
    setCreatingTrustedKey(true);
    const res = await api.createTrustedBackendKey(projectId, {
      name: newTrustedKeyName || undefined,
      scopes: trustedKeyScopes,
    });
    if (res.success && res.data) {
      setNewTrustedKey(res.data);
      setTrustedKeys((prev) => [res.data!.trustedBackendKey, ...prev]);
      setNewTrustedKeyName('');
      setTrustedKeyScopes(['project_session:issue', 'storage_ticket:issue']);
      setShowTrustedCreateForm(false);
    }
    setCreatingTrustedKey(false);
  }

  async function handleDeleteTrustedKey(id: number) {
    if (!confirm('确定要删除此 Trusted Backend Key 吗？此操作不可恢复。')) return;
    setDeletingTrustedId(id);
    const res = await api.deleteTrustedBackendKey(projectId, id);
    if (res.success) {
      setTrustedKeys((prev) => prev.filter((k) => k.id !== id));
    }
    setDeletingTrustedId(null);
  }

  function toggleTrustedScope(scope: TrustedBackendKeyScope) {
    setTrustedKeyScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((item) => item !== scope)
        : [...prev, scope]
    );
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('zh-CN');
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
            {currentProject?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">
            设置
          </Link>
          <span>/</span>
          <span>API Keys</span>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Access Keys</h1>
        </div>
        <p className="text-gray-500 mt-2">
          在这里分别管理匿名 API Key 与受信服务端使用的 Trusted Backend Key。
        </p>
      </div>

      {/* New Key Alert */}
      {newKey && (
        <div className="card mb-6 border-green-200 bg-green-50">
          <div className="card-body">
            <h3 className="font-semibold text-green-800 mb-2">API Key 创建成功</h3>
            <p className="text-sm text-green-700 mb-3">
              请立即复制此密钥，它只会显示一次。
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white px-3 py-2 rounded border font-mono text-sm">
                {newKey.key}
              </code>
              <button
                onClick={() => copyToClipboard(newKey.key)}
                className="btn btn-secondary"
              >
                复制
              </button>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="mt-3 text-sm text-green-600 hover:underline"
            >
              我已保存密钥
            </button>
          </div>
        </div>
      )}

      {newTrustedKey && (
        <div className="card mb-6 border-blue-200 bg-blue-50">
          <div className="card-body">
            <h3 className="font-semibold text-blue-800 mb-2">Trusted Backend Key 创建成功</h3>
            <p className="text-sm text-blue-700 mb-3">
              请立即复制此密钥，它只会显示一次。此密钥仅用于受信服务端，不应下发到浏览器或小程序。
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white px-3 py-2 rounded border font-mono text-sm">
                {newTrustedKey.key}
              </code>
              <button
                onClick={() => copyToClipboard(newTrustedKey.key)}
                className="btn btn-secondary"
              >
                复制
              </button>
            </div>
            <button
              onClick={() => setNewTrustedKey(null)}
              className="mt-3 text-sm text-blue-600 hover:underline"
            >
              我已保存密钥
            </button>
          </div>
        </div>
      )}

      {/* Create Form Modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-full max-w-md">
            <div className="card-header">
              <h2 className="font-semibold">创建 API Key</h2>
            </div>
            <form onSubmit={handleCreate} className="card-body space-y-4">
              <div>
                <label className="label">名称（可选）</label>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="例如：MCP Server"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="btn btn-secondary"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary"
                >
                  {creating ? '创建中...' : '创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showTrustedCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-full max-w-lg">
            <div className="card-header">
              <h2 className="font-semibold">创建 Trusted Backend Key</h2>
            </div>
            <form onSubmit={handleCreateTrustedKey} className="card-body space-y-4">
              <div>
                <label className="label">名称（可选）</label>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="例如：H5 Backend"
                  value={newTrustedKeyName}
                  onChange={(e) => setNewTrustedKeyName(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Scopes</label>
                <div className="space-y-3 rounded border p-3">
                  {TRUSTED_BACKEND_SCOPE_OPTIONS.map((scope) => (
                    <label key={scope.value} className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={trustedKeyScopes.includes(scope.value)}
                        onChange={() => toggleTrustedScope(scope.value)}
                      />
                      <div>
                        <div className="font-medium text-sm">{scope.label}</div>
                        <div className="text-sm text-gray-500">{scope.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  不勾选任何 scope 时，后端会回退为默认全量 scope。建议按最小权限显式勾选。
                </p>
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Trusted Backend Key 仅用于受信服务端签发 project session / storage ticket，不应下发给浏览器、H5 客户端或小程序。
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowTrustedCreateForm(false)}
                  className="btn btn-secondary"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creatingTrustedKey}
                  className="btn btn-primary"
                >
                  {creatingTrustedKey ? '创建中...' : '创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Keys List */}
      <div className="card">
        <div className="card-header">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">已创建的 API Keys</h2>
              <p className="text-sm text-gray-500 mt-1">
                面向匿名访问、MCP、公开 GraphQL 等项目级 API key。
              </p>
            </div>
            <button
              onClick={() => setShowCreateForm(true)}
              className="btn btn-primary"
            >
              创建 API Key
            </button>
          </div>
        </div>
        <div className="card-body p-0">
          {keys.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              暂无 API Keys，点击上方按钮创建。
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">名称</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Key 前缀</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">创建时间</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">最后使用</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {keys.map((key) => (
                  <tr key={key.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">{key.name || '-'}</td>
                    <td className="px-4 py-3 font-mono text-sm">{key.keyPrefix}...</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDate(key.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDate(key.lastUsedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(key.id)}
                        disabled={deletingId === key.id}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        {deletingId === key.id ? '删除中...' : '删除'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card mt-6">
        <div className="card-header">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">Trusted Backend Keys</h2>
              <p className="text-sm text-gray-500 mt-1">
                面向受信服务端，支持签发标准 project session 与受限 storage ticket。
              </p>
            </div>
            <button
              onClick={() => setShowTrustedCreateForm(true)}
              className="btn btn-primary"
            >
              创建 Trusted Key
            </button>
          </div>
        </div>
        <div className="card-body p-0">
          {trustedKeys.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              暂无 Trusted Backend Keys，点击上方按钮创建。
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">名称</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Key 前缀</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Scopes</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">创建时间</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">最后使用</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {trustedKeys.map((key) => (
                  <tr key={key.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">{key.name || '-'}</td>
                    <td className="px-4 py-3 font-mono text-sm">{key.keyPrefix}...</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {key.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700"
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDate(key.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDate(key.lastUsedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDeleteTrustedKey(key.id)}
                        disabled={deletingTrustedId === key.id}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        {deletingTrustedId === key.id ? '删除中...' : '删除'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* MCP Usage Guide */}
      <div className="card mt-6">
        <div className="card-header">
          <h2 className="font-semibold">MCP Server 使用指南</h2>
        </div>
        <div className="card-body space-y-4">
          <p className="text-gray-600">
            使用 API Key 配置 MCP Server 以访问此项目的数据。
          </p>
          <div className="bg-gray-50 rounded p-4">
            <p className="text-sm font-medium mb-2">Claude Desktop 配置示例：</p>
            <pre className="text-sm overflow-x-auto">
{`{
  "mcpServers": {
    "druvia": {
      "command": "npx",
      "args": ["@druvia/mcp-server"],
      "env": {
        "DRUVIA_API_KEY": "your-api-key-here",
        "DRUVIA_API_URL": "${typeof window !== 'undefined' ? window.location.origin.replace(':3000', ':3001') : 'http://localhost:3001'}"
      }
    }
  }
}`}
            </pre>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
