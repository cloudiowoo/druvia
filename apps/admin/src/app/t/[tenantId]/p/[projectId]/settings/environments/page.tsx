'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Plus, Trash2, GitBranch, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Environment {
  id: number;
  projectId: string;
  envName: string;
  schemaName: string;
  createdAt: string;
}

export default function EnvironmentsPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newEnvName, setNewEnvName] = useState('');
  const [cloneData, setCloneData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchEnvironments();
  }, [projectId]);

  async function fetchEnvironments() {
    setLoading(true);
    const res = await api.listEnvironments(projectId);
    if (res.success && res.data) {
      setEnvironments(res.data);
    }
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEnvName.trim()) return;

    setCreating(true);
    setError(null);

    const res = await api.createEnvironment(projectId, newEnvName.trim(), cloneData);
    if (res.success && res.data) {
      setEnvironments([...environments, res.data]);
      setShowCreateForm(false);
      setNewEnvName('');
      setCloneData(false);
    } else {
      setError(res.error?.message || '创建环境失败');
    }
    setCreating(false);
  }

  async function handleDelete(envName: string) {
    const res = await api.deleteEnvironment(projectId, envName);
    if (res.success) {
      setEnvironments(environments.filter((e) => e.envName !== envName));
      setDeleteConfirm(null);
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

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
          <span>环境</span>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">环境管理</h1>
          <Button onClick={() => setShowCreateForm(true)} disabled={showCreateForm}>
            <Plus className="h-4 w-4 mr-2" />
            新建环境
          </Button>
        </div>
        <p className="text-gray-500 mt-2">
          管理项目的开发、测试和生产环境。每个环境拥有独立的数据库 Schema。
        </p>
      </div>

      {showCreateForm && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="font-semibold">创建新环境</h2>
          </div>
          <form onSubmit={handleCreate} className="card-body space-y-4">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 text-red-600 rounded-md">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
            <div>
              <label className="label">环境名称</label>
              <input
                type="text"
                className="input w-full max-w-md"
                placeholder="例如: dev, staging, test"
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value.toLowerCase())}
                pattern="^[a-z][a-z0-9_]*$"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                只能包含小写字母、数字和下划线，必须以字母开头
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cloneData"
                checked={cloneData}
                onChange={(e) => setCloneData(e.target.checked)}
                className="rounded border-gray-300"
              />
              <label htmlFor="cloneData" className="text-sm text-gray-600">
                复制生产环境数据（仅复制表结构和数据）
              </label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={creating || !newEnvName.trim()}>
                {creating ? '创建中...' : '创建'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowCreateForm(false);
                  setNewEnvName('');
                  setCloneData(false);
                  setError(null);
                }}
              >
                取消
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold">环境列表</h2>
        </div>
        <div className="card-body p-0">
          {environments.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <GitBranch className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p>暂无环境</p>
              <p className="text-sm">创建第一个环境来开始</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                    环境名称
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                    Schema
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                    创建时间
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-500">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {environments.map((env) => (
                  <tr key={env.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-gray-400" />
                        <span className="font-medium">{env.envName}</span>
                        {env.envName === 'prod' && (
                          <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
                            生产
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-sm bg-gray-100 px-2 py-1 rounded">
                        {env.schemaName}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {formatDate(env.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {env.envName === 'prod' ? (
                        <span className="text-xs text-gray-400">不可删除</span>
                      ) : deleteConfirm === env.envName ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-sm text-red-600">确认删除?</span>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(env.envName)}
                          >
                            删除
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteConfirm(env.envName)}
                        >
                          <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
