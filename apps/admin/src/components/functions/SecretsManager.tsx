'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2, Eye, EyeOff, Loader2, Key } from 'lucide-react';
import { api } from '@/lib/api';
import type { FunctionSecret } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SecretsManagerProps {
  projectId: string;
}

export function SecretsManager({ projectId }: SecretsManagerProps) {
  const [secrets, setSecrets] = useState<FunctionSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    async function loadSecrets() {
      setLoading(true);
      try {
        const res = await api.listSecrets(projectId);
        if (res.success && res.data) {
          setSecrets(res.data);
        }
      } finally {
        setLoading(false);
      }
    }
    loadSecrets();
  }, [projectId]);

  const refreshSecrets = async () => {
    const res = await api.listSecrets(projectId);
    if (res.success && res.data) {
      setSecrets(res.data);
    }
  };

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;

    setSaving(true);
    try {
      const res = await api.createSecret(projectId, newKey.trim(), newValue);
      if (res.success) {
        await refreshSecrets();
        setShowAdd(false);
        setNewKey('');
        setNewValue('');
      }
    } finally {
      setSaving(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleDelete = async (key: string) => {
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      return;
    }
    setConfirmDelete(null);
    setDeleting(key);
    try {
      const res = await api.deleteSecret(projectId, key);
      if (res.success) {
        setSecrets(secrets.filter((s) => s.key !== key));
      }
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-gray-500" />
          <h3 className="font-medium text-sm">Secrets</h3>
          <span className="text-xs text-gray-500">({secrets.length})</span>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="p-1.5 hover:bg-gray-200 rounded transition-colors"
          title="添加 Secret"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Add Form */}
      {showAdd && (
        <div className="p-4 border-b bg-blue-50">
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Key</label>
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="MY_SECRET_KEY"
                className="w-full px-3 py-2 border rounded text-sm font-mono"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Value</label>
              <div className="relative">
                <input
                  type={showValue ? 'text' : 'password'}
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="secret value"
                  className="w-full px-3 py-2 pr-10 border rounded text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowValue(!showValue)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded"
                >
                  {showValue ? (
                    <EyeOff className="h-4 w-4 text-gray-500" />
                  ) : (
                    <Eye className="h-4 w-4 text-gray-500" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAdd(false);
                  setNewKey('');
                  setNewValue('');
                }}
                className="btn btn-sm"
              >
                取消
              </button>
              <button
                onClick={handleAdd}
                disabled={saving || !newKey.trim() || !newValue.trim()}
                className="btn btn-sm btn-primary flex items-center gap-1"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secrets List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : secrets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <Key className="h-8 w-8 mb-2" />
            <p className="text-sm">暂无 Secrets</p>
            <p className="text-xs mt-1">Secrets 可在函数中通过 Deno.env.get() 访问</p>
          </div>
        ) : (
          <div className="divide-y">
            {secrets.map((secret) => (
              <div
                key={secret.id}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
              >
                <div>
                  <p className="font-mono text-sm">{secret.key}</p>
                  <p className="text-xs text-gray-500">
                    {new Date(secret.updatedAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                <button
                  onClick={() => confirmDelete === secret.key ? handleDelete(secret.key) : setConfirmDelete(secret.key)}
                  onBlur={() => setTimeout(() => setConfirmDelete(null), 200)}
                  disabled={deleting === secret.key}
                  className={cn(
                    "p-1.5 rounded transition-colors",
                    confirmDelete === secret.key
                      ? "bg-red-500 text-white hover:bg-red-600"
                      : "hover:bg-red-100 text-red-600"
                  )}
                  title={confirmDelete === secret.key ? "再次点击确认删除" : "删除"}
                >
                  {deleting === secret.key ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Usage hint */}
      <div className="px-4 py-2 border-t bg-gray-50 text-xs text-gray-500">
        在函数中使用: <code className="bg-gray-200 px-1 rounded">Deno.env.get("KEY")</code>
      </div>
    </div>
  );
}
