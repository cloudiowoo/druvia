'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';

interface Backup {
  backupId: string;
  tenantId: string;
  projectId: string | null;
  schemaName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  sizeBytes: number | string;
  createdAt: string;
}

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
}

interface Project {
  projectId: string;
  alias: string;
  name: string;
  schemaName?: string;
}

export default function BackupsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ backupId: string; input: string } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTenants() {
      const res = await api.listTenants();
      if (res.success && res.data) {
        setTenants(res.data);
      }
    }
    fetchTenants();
    fetchBackups();
  }, []);

  useEffect(() => {
    if (!selectedTenant) {
      setProjects([]);
      setSelectedProject('');
      return;
    }

    async function fetchProjects() {
      const res = await api.listProjects(selectedTenant);
      if (res.success && res.data) {
        setProjects(res.data);
      }
    }
    fetchProjects();
  }, [selectedTenant]);

  async function fetchBackups() {
    setLoading(true);
    try {
      const res = await api.listAllBackups({
        tenantId: selectedTenant || undefined,
        projectId: selectedProject || undefined,
      });
      if (res.success && res.data) {
        setBackups(res.data.backups as Backup[]);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBackups();
  }, [selectedTenant, selectedProject]);

  const handleCreateBackup = async () => {
    if (!selectedTenant || !selectedProject) return;

    const tenant = tenants.find((t) => t.tenantId === selectedTenant);
    const project = projects.find((p) => p.projectId === selectedProject);
    if (!tenant || !project) return;

    setCreating(true);
    try {
      const schemaName = `dru_${tenant.alias}_${project.alias}`;
      const res = await api.createBackup(selectedTenant, schemaName, selectedProject);
      if (res.success) {
        fetchBackups();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (backupId: string) => {
    const res = await api.downloadBackup(backupId);
    if (res.success && res.data?.url) {
      window.open(res.data.url, '_blank');
    }
  };

  const handleRestore = async (backupId: string) => {
    setRestoreConfirm(backupId);
  };

  const handleConfirmRestore = async () => {
    if (!restoreConfirm) return;
    setRestoring(restoreConfirm);
    setRestoreConfirm(null);
    try {
      const res = await api.restoreBackup(restoreConfirm);
      if (res.success) {
        toast({ title: '备份恢复成功' });
      } else {
        toast({ title: '恢复失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setRestoring(null);
    }
  };

  const openDeleteConfirm = (backupId: string) => {
    setDeleteConfirm({ backupId, input: '' });
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const res = await api.deleteBackup(deleteConfirm.backupId);
    if (res.success) {
      setBackups(backups.filter(b => b.backupId !== deleteConfirm.backupId));
      setDeleteConfirm(null);
      toast({ title: '备份已删除' });
    } else {
      toast({ title: '删除失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  const formatSize = (bytes: number | string | null | undefined) => {
    const num = Number(bytes);
    if (bytes === null || bytes === undefined || isNaN(num) || num === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(num) / Math.log(k));
    return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
      {/* Restore Confirmation Dialog */}
      <AlertDialog open={!!restoreConfirm} onOpenChange={() => setRestoreConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认恢复备份</AlertDialogTitle>
            <AlertDialogDescription>
              确定要恢复此备份吗？这将覆盖当前数据，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRestore} className="bg-orange-600 text-white hover:bg-orange-700">
              确认恢复
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-600">确认删除备份</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="mb-4">此操作不可恢复。请输入备份 ID 以确认删除：</p>
                <p className="font-mono text-sm bg-gray-100 p-2 rounded mb-4">
                  {deleteConfirm?.backupId}
                </p>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="输入备份 ID"
                  value={deleteConfirm?.input || ''}
                  onChange={(e) => deleteConfirm && setDeleteConfirm({ ...deleteConfirm, input: e.target.value })}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirm?.input !== deleteConfirm?.backupId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">备份管理</h1>
          <p className="text-gray-500">管理租户数据备份 (共 {total} 条)</p>
        </div>
        <button
          onClick={handleCreateBackup}
          className="btn btn-primary"
          disabled={!selectedTenant || !selectedProject || creating}
        >
          {creating ? '创建中...' : '创建备份'}
        </button>
      </div>

      <div className="card mb-6">
        <div className="card-body flex gap-4">
          <div>
            <label className="label">筛选租户</label>
            <select
              className="input"
              value={selectedTenant}
              onChange={(e) => setSelectedTenant(e.target.value)}
            >
              <option value="">全部租户</option>
              {tenants.map((tenant) => (
                <option key={tenant.tenantId} value={tenant.tenantId}>
                  {tenant.name} ({tenant.alias})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">筛选项目</label>
            <select
              className="input"
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              disabled={!selectedTenant}
            >
              <option value="">全部项目</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name} ({project.alias})
                </option>
              ))}
            </select>
          </div>
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
                  <td className="text-gray-500">{formatDate(backup.createdAt)}</td>
                  <td>
                    <div className="flex gap-2">
                      {backup.status === 'completed' && (
                        <>
                          <button
                            onClick={() => handleDownload(backup.backupId)}
                            className="text-sm text-primary-600 hover:underline"
                          >
                            下载
                          </button>
                          <button
                            onClick={() => handleRestore(backup.backupId)}
                            disabled={restoring === backup.backupId}
                            className="text-sm text-orange-600 hover:underline disabled:opacity-50"
                          >
                            {restoring === backup.backupId ? '恢复中...' : '恢复'}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => openDeleteConfirm(backup.backupId)}
                        className="text-sm text-red-600 hover:underline"
                      >
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
