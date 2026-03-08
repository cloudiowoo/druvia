'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { isMultiTenantEnabled } from '@/lib/tenant-config';
import { toast } from '@/hooks/use-toast';

interface TenantDetails {
  tenantId: string;
  alias: string;
  name: string;
  plan: string;
  status: string;
  settings: Record<string, unknown>;
}

interface TenantUsage {
  storage: { used: number; limit: number };
  projects: { used: number; limit: number };
  users: { used: number; limit: number };
}

export default function TenantSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const { currentTenant, setCurrentTenant } = useAppStore();
  const multiTenant = isMultiTenantEnabled();

  const [tenant, setTenant] = useState<TenantDetails | null>(null);
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const [formData, setFormData] = useState({ name: '' });

  useEffect(() => {
    async function fetchTenant() {
      const res = await api.getTenant(tenantId);
      if (res.success && res.data) {
        setTenant(res.data);
        setFormData({ name: res.data.name });
      }
      setLoading(false);
    }
    async function fetchUsage() {
      const res = await api.getTenantUsage(tenantId);
      if (res.success && res.data) {
        setUsage(res.data);
      }
    }
    fetchTenant();
    fetchUsage();
  }, [tenantId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.updateTenant(tenantId, { name: formData.name });
      if (res.success && res.data) {
        setTenant((prev) => prev ? { ...prev, name: res.data!.name } : null);
        if (currentTenant?.tenantId === tenantId) {
          setCurrentTenant({ ...currentTenant, name: res.data.name });
        }
        toast({ title: '设置已保存' });
      } else {
        toast({ title: '保存失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm !== tenant?.alias) return;
    setDeleting(true);
    try {
      const res = await api.deleteTenant(tenantId);
      if (res.success) {
        router.push('/tenants');
      }
    } finally {
      setDeleting(false);
    }
  };

  const getPlanLabel = (plan: string) => {
    const labels: Record<string, string> = {
      free: '免费版',
      pro: '专业版',
      enterprise: '企业版',
    };
    return labels[plan] || plan;
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-green-100 text-green-700',
      suspended: 'bg-yellow-100 text-yellow-700',
      deleted: 'bg-red-100 text-red-700',
    };
    const labels: Record<string, string> = {
      active: '正常',
      suspended: '已暂停',
      deleted: '已删除',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs ${styles[status] || 'bg-gray-100'}`}>
        {labels[status] || status}
      </span>
    );
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getUsagePercent = (used: number, limit: number) => {
    if (limit === 0) return 0;
    return Math.min(100, Math.round((used / limit) * 100));
  };

  const getUsageColor = (percent: number) => {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  if (!tenant) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-gray-500">租户不存在</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {multiTenant ? (currentTenant?.name || tenant.name) : 'Druvia'}
          </Link>
          <span>/</span>
          <span>设置</span>
        </div>
        <h1 className="text-2xl font-bold">{multiTenant ? '租户设置' : '工作区设置'}</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 基本信息 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">基本信息</h2>
          </div>
          <form onSubmit={handleSave} className="card-body space-y-4">
            <div>
              <label className="label">租户别名</label>
              <input
                type="text"
                className="input w-full bg-gray-50"
                value={tenant.alias}
                disabled
              />
              <p className="text-xs text-gray-500 mt-1">别名创建后不可修改</p>
            </div>
            <div>
              <label className="label">租户名称</label>
              <input
                type="text"
                className="input w-full"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? '保存中...' : '保存'}
            </button>
          </form>
        </div>

        {/* 套餐信息 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">套餐信息</h2>
          </div>
          <div className="card-body space-y-4">
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">当前套餐</span>
              <span className="font-medium">{getPlanLabel(tenant.plan)}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">状态</span>
              {getStatusBadge(tenant.status)}
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-500">租户 ID</span>
              <span className="font-mono text-sm">{tenant.tenantId}</span>
            </div>
          </div>
        </div>

        {/* 配额使用情况 */}
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="font-semibold">配额使用情况</h2>
          </div>
          <div className="card-body">
            {usage ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* 存储使用 */}
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-500">存储空间</span>
                    <span className="text-sm">
                      {formatBytes(usage.storage.used)} / {formatBytes(usage.storage.limit)}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${getUsageColor(getUsagePercent(usage.storage.used, usage.storage.limit))}`}
                      style={{ width: `${getUsagePercent(usage.storage.used, usage.storage.limit)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    已使用 {getUsagePercent(usage.storage.used, usage.storage.limit)}%
                  </p>
                </div>

                {/* 项目数量 */}
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-500">项目数量</span>
                    <span className="text-sm">
                      {usage.projects.used} / {usage.projects.limit}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${getUsageColor(getUsagePercent(usage.projects.used, usage.projects.limit))}`}
                      style={{ width: `${getUsagePercent(usage.projects.used, usage.projects.limit)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    已使用 {getUsagePercent(usage.projects.used, usage.projects.limit)}%
                  </p>
                </div>

                {/* 用户数量 */}
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-500">用户数量</span>
                    <span className="text-sm">
                      {usage.users.used} / {usage.users.limit}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${getUsageColor(getUsagePercent(usage.users.used, usage.users.limit))}`}
                      style={{ width: `${getUsagePercent(usage.users.used, usage.users.limit)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    已使用 {getUsagePercent(usage.users.used, usage.users.limit)}%
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-gray-500 text-center py-4">加载配额信息...</p>
            )}
          </div>
        </div>

        {/* 危险操作 - 仅多租户模式显示 */}
        {multiTenant && (
          <div className="card lg:col-span-2 border-red-200">
            <div className="card-header bg-red-50">
              <h2 className="font-semibold text-red-600">危险操作</h2>
            </div>
            <div className="card-body">
              <p className="text-gray-600 mb-4">
                删除租户将永久删除所有项目、数据表和备份。此操作不可恢复。
              </p>
              <div className="space-y-4">
                <div>
                  <label className="label">输入租户别名 <span className="font-mono">{tenant.alias}</span> 以确认删除</label>
                  <input
                    type="text"
                    className="input w-full max-w-md"
                    placeholder={tenant.alias}
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                  />
                </div>
                <button
                  onClick={handleDelete}
                  disabled={deleteConfirm !== tenant.alias || deleting}
                  className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? '删除中...' : '删除租户'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
