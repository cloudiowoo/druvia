'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

interface ProjectDetails {
  projectId: string;
  tenantId: string;
  alias: string;
  name: string;
  schemaName: string;
  status: string;
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject, setCurrentProject } = useAppStore();

  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const [formData, setFormData] = useState({ name: '' });

  useEffect(() => {
    async function fetchProject() {
      const res = await api.getProject(projectId);
      if (res.success && res.data) {
        setProject(res.data);
        setFormData({ name: res.data.name });
      }
      setLoading(false);
    }
    fetchProject();
  }, [projectId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.updateProject(projectId, { name: formData.name });
      if (res.success && res.data) {
        setProject((prev) => prev ? { ...prev, name: res.data!.name } : null);
        if (currentProject?.projectId === projectId) {
          setCurrentProject({ ...currentProject, name: res.data.name });
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm !== project?.alias) return;
    setDeleting(true);
    try {
      const res = await api.deleteProject(projectId);
      if (res.success) {
        router.push(`/t/${tenantId}`);
      }
    } finally {
      setDeleting(false);
    }
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

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  if (!project) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-gray-500">项目不存在</div>
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
            {currentProject?.name || project.name}
          </Link>
          <span>/</span>
          <span>设置</span>
        </div>
        <h1 className="text-2xl font-bold">项目设置</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 基本信息 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">基本信息</h2>
          </div>
          <form onSubmit={handleSave} className="card-body space-y-4">
            <div>
              <label className="label">项目别名</label>
              <input
                type="text"
                className="input w-full bg-gray-50"
                value={project.alias}
                disabled
              />
              <p className="text-xs text-gray-500 mt-1">别名创建后不可修改</p>
            </div>
            <div>
              <label className="label">项目名称</label>
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

        {/* 项目信息 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">项目信息</h2>
          </div>
          <div className="card-body space-y-4">
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">Schema 名称</span>
              <span className="font-mono text-sm">{project.schemaName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-gray-500">状态</span>
              {getStatusBadge(project.status)}
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-500">项目 ID</span>
              <span className="font-mono text-sm">{project.projectId}</span>
            </div>
          </div>
        </div>

        {/* 危险操作 */}
        <div className="card lg:col-span-2 border-red-200">
          <div className="card-header bg-red-50">
            <h2 className="font-semibold text-red-600">危险操作</h2>
          </div>
          <div className="card-body">
            <p className="text-gray-600 mb-4">
              删除项目将永久删除所有数据表和备份。此操作不可恢复。
            </p>
            <div className="space-y-4">
              <div>
                <label className="label">输入项目别名 <span className="font-mono">{project.alias}</span> 以确认删除</label>
                <input
                  type="text"
                  className="input w-full max-w-md"
                  placeholder={project.alias}
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                />
              </div>
              <button
                onClick={handleDelete}
                disabled={deleteConfirm !== project.alias || deleting}
                className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? '删除中...' : '删除项目'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
