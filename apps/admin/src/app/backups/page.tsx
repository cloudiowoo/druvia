'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface Backup {
  backupId: string;
  tenantId: string;
  schemaName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  sizeBytes: number;
  tablesCount: number;
  createdAt: string;
  completedAt: string | null;
}

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
}

export default function BackupsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    async function fetchTenants() {
      const res = await api.listTenants();
      if (res.success && res.data) {
        setTenants(res.data);
        if (res.data.length > 0) {
          setSelectedTenant(res.data[0].tenantId);
        }
      }
    }
    fetchTenants();
  }, []);

  useEffect(() => {
    if (!selectedTenant) return;

    async function fetchBackups() {
      setLoading(true);
      try {
        const res = await api.listBackups(selectedTenant);
        if (res.success && res.data) {
          setBackups(res.data as Backup[]);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchBackups();
  }, [selectedTenant]);

  const handleCreateBackup = async () => {
    if (!selectedTenant) return;

    const tenant = tenants.find((t) => t.tenantId === selectedTenant);
    if (!tenant) return;

    setCreating(true);
    try {
      const schemaName = `tenant_${tenant.alias}`;
      const res = await api.createBackup(selectedTenant, schemaName);
      if (res.success && res.data) {
        // Refresh backups list
        const backupsRes = await api.listBackups(selectedTenant);
        if (backupsRes.success && backupsRes.data) {
          setBackups(backupsRes.data as Backup[]);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const getStatusBadge = (status: Backup['status']) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-700',
      running: 'bg-blue-100 text-blue-700',
      completed: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
    };
    const labels = {
      pending: '等待中',
      running: '进行中',
      completed: '已完成',
      failed: '失败',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs ${styles[status]}`}>
        {labels[status]}
      </span>
    );
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">备份管理</h1>
          <p className="text-gray-500">管理租户数据备份</p>
        </div>
        <button
          onClick={handleCreateBackup}
          className="btn btn-primary"
          disabled={!selectedTenant || creating}
        >
          {creating ? '创建中...' : '创建备份'}
        </button>
      </div>

      <div className="card mb-6">
        <div className="card-body">
          <label className="label">选择租户</label>
          <select
            className="input max-w-xs"
            value={selectedTenant}
            onChange={(e) => setSelectedTenant(e.target.value)}
          >
            {tenants.map((tenant) => (
              <option key={tenant.tenantId} value={tenant.tenantId}>
                {tenant.name} ({tenant.alias})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="p-8 text-center text-gray-500">加载中...</div>
        ) : backups.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            暂无备份记录
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>备份 ID</th>
                <th>Schema</th>
                <th>状态</th>
                <th>大小</th>
                <th>表数量</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.backupId}>
                  <td className="font-mono text-sm">{backup.backupId}</td>
                  <td className="text-gray-500">{backup.schemaName}</td>
                  <td>{getStatusBadge(backup.status)}</td>
                  <td>{formatSize(backup.sizeBytes)}</td>
                  <td>{backup.tablesCount || '-'}</td>
                  <td className="text-gray-500">{formatDate(backup.createdAt)}</td>
                  <td>
                    <div className="flex gap-2">
                      {backup.status === 'completed' && (
                        <>
                          <button className="text-sm text-primary-600 hover:underline">
                            下载
                          </button>
                          <button className="text-sm text-orange-600 hover:underline">
                            恢复
                          </button>
                        </>
                      )}
                      <button className="text-sm text-red-600 hover:underline">
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </DashboardLayout>
  );
}
