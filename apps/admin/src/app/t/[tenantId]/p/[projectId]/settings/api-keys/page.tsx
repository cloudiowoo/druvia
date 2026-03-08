'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

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

export default function ApiKeysPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState<NewKeyResult | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    fetchKeys();
  }, [projectId]);

  async function fetchKeys() {
    setLoading(true);
    const res = await api.listApiKeys(projectId);
    if (res.success && res.data) {
      setKeys(res.data);
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
          <h1 className="text-2xl font-bold">API Keys</h1>
          <button
            onClick={() => setShowCreateForm(true)}
            className="btn btn-primary"
          >
            创建 API Key
          </button>
        </div>
        <p className="text-gray-500 mt-2">
          API Keys 用于 MCP Server 和外部集成访问项目数据。
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

      {/* Keys List */}
      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold">已创建的 API Keys</h2>
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
