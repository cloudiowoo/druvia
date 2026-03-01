'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

interface Backup {
  backupId: string;
  tenantId: string;
  projectId: string | null;
  schemaName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  sizeBytes: number | string;
  createdAt: string;
}

interface Project {
  projectId: string;
  alias: string;
  name: string;
  schemaName?: string;
}

export default function TenantBackupsPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ backupId: string; input: string } | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      const res = await api.listProjects(tenantId);
      if (res.success && res.data) {
        setProjects(res.data);
      }
    }
    async function fetchBackupsInitial() {
      setLoading(true);
      try {
        const res = await api.listAllBackups({ tenantId });
        if (res.success && res.data) {
          setBackups(res.data.backups as Backup[]);
          setTotal(res.data.total);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchProjects();
    fetchBackupsInitial();
  }, [tenantId]);

  const fetchBackups = async () => {
    setLoading(true);
    try {
      const res = await api.listAllBackups({
        tenantId,
        projectId: selectedProject || undefined,
      });
      if (res.success && res.data) {
        setBackups(res.data.backups as Backup[]);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedProject !== '') {
      fetchBackups();
    }
  }, [selectedProject]);

  const handleCreateBackup = async () => {
    if (!selectedProject) return;
    const project = projects.find((p) => p.projectId === selectedProject);
    if (!project || !currentTenant) return;

    setCreating(true);
    try {
      const schemaName = `dru_${currentTenant.alias}_${project.alias}`;
      const res = await api.createBackup(tenantId, schemaName, selectedProject);
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
    if (!confirm('确定要恢复此备份吗？这将覆盖当前数据。')) return;
    setRestoring(backupId);
    try {
      const res = await api.restoreBackup(backupId);
      if (res.success) {
        alert('备份恢复成功');
      }
    } finally {
      setRestoring(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const res = await api.deleteBackup(deleteConfirm.backupId);
    if (res.success) {
      setBackups(backups.filter(b => b.backupId !== deleteConfirm.backupId));
      setDeleteConfirm(null);
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
      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4 text-red-600">确认删除备份</h3>
            <p className="text-gray-600 mb-4">
              此操作不可恢复。请输入备份 ID 以确认删除：
            </p>
            <p className="font-mono text-sm bg-gray-100 p-2 rounded mb-4">
              {deleteConfirm.backupId}
            </p>
            <input
              type="text"
              className="input w-full mb-4"
              placeholder="输入备份 ID"
              value={deleteConfirm.input}
              onChange={(e) => setDeleteConfirm({ ...deleteConfirm, input: e.target.value })}
            />
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="btn flex-1">
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirm.input !== deleteConfirm.backupId}
                className="btn bg-red-600 text-white hover:bg-red-700 flex-1 disabled:opacity-50"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href={`/t/${tenantId}`} className="hover:text-foreground">
              {currentTenant?.name}
            </Link>
            <span>/</span>
            <span>备份</span>
          </div>
          <h1 className="text-2xl font-bold">备份管理</h1>
          <p className="text-gray-500">共 {total} 条备份记录</p>
        </div>
        <button
          onClick={handleCreateBackup}
          className="btn btn-primary"
          disabled={!selectedProject || creating}
        >
          {creating ? '创建中...' : '创建备份'}
        </button>
      </div>

      <div className="card mb-6">
        <div className="card-body flex gap-4">
          <div>
            <label className="label">选择项目</label>
            <select
              className="input"
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
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
          <div className="p-8 text-center text-gray-500">暂无备份记录</div>
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
                        onClick={() => setDeleteConfirm({ backupId: backup.backupId, input: '' })}
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
