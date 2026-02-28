'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
  description: string | null;
  plan: string;
  status: string;
  storageLimit: number;
  projectLimit: number;
  userLimit: number;
  settings: Record<string, unknown>;
}

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

interface EditFormData {
  name: string;
  description: string;
  plan: string;
  status: string;
  storageLimit: number;
  projectLimit: number;
  userLimit: number;
}

export default function TenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [editFormData, setEditFormData] = useState<EditFormData>({
    name: '',
    description: '',
    plan: 'free',
    status: 'active',
    storageLimit: 1,
    projectLimit: 5,
    userLimit: 10,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [tenantRes, projectsRes] = await Promise.all([
          api.getTenant(tenantId),
          api.listProjects(tenantId),
        ]);

        if (tenantRes.success && tenantRes.data) {
          const t = tenantRes.data as Tenant;
          setTenant(t);
          setEditFormData({
            name: t.name,
            description: t.description || '',
            plan: t.plan,
            status: t.status,
            storageLimit: t.storageLimit / (1024 * 1024 * 1024),
            projectLimit: t.projectLimit,
            userLimit: t.userLimit,
          });
        }
        if (projectsRes.success && projectsRes.data) {
          setProjects(projectsRes.data);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [tenantId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.updateTenant(tenantId, {
        name: editFormData.name,
        description: editFormData.description || undefined,
        plan: editFormData.plan,
        status: editFormData.status,
        storageLimit: editFormData.storageLimit * 1024 * 1024 * 1024,
        projectLimit: editFormData.projectLimit,
        userLimit: editFormData.userLimit,
      });
      if (res.success && res.data) {
        setTenant(res.data as Tenant);
        setShowEditDialog(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  const handleDelete = async () => {
    if (!tenant || deleteInput !== tenant.alias) return;
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

  if (loading) {
    return (
      <DashboardLayout>
        <div className="text-center py-12 text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  if (!tenant) {
    return (
      <DashboardLayout>
        <div className="text-center py-12 text-gray-500">租户不存在</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      {/* Delete Confirmation Dialog */}
      {showDeleteDialog && tenant && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4 text-red-600">确认删除租户</h3>
            <p className="text-gray-600 mb-2">
              此操作将删除租户及其所有项目、数据、备份，不可恢复！
            </p>
            <p className="text-gray-600 mb-4">
              请输入租户别名 <span className="font-mono font-bold">{tenant.alias}</span> 以确认删除：
            </p>
            <input
              type="text"
              className="input w-full mb-4"
              placeholder="输入租户别名"
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDeleteDialog(false); setDeleteInput(''); }}
                className="btn flex-1"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteInput !== tenant.alias || deleting}
                className="btn bg-red-600 text-white hover:bg-red-700 flex-1 disabled:opacity-50"
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      {showEditDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">编辑租户</h3>
            <form onSubmit={handleSave}>
              <div className="space-y-4">
                <div>
                  <label className="label">名称</label>
                  <input
                    type="text"
                    required
                    className="input w-full"
                    value={editFormData.name}
                    onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">描述</label>
                  <textarea
                    className="input w-full"
                    rows={2}
                    value={editFormData.description}
                    onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">套餐</label>
                    <select
                      className="input w-full"
                      value={editFormData.plan}
                      onChange={(e) => setEditFormData({ ...editFormData, plan: e.target.value })}
                    >
                      <option value="free">免费版</option>
                      <option value="pro">专业版</option>
                      <option value="enterprise">企业版</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">状态</label>
                    <select
                      className="input w-full"
                      value={editFormData.status}
                      onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value })}
                    >
                      <option value="active">活跃</option>
                      <option value="suspended">已暂停</option>
                      <option value="deleted">已删除</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="label">存储限制 (GB)</label>
                    <input
                      type="number"
                      min={1}
                      className="input w-full"
                      value={editFormData.storageLimit}
                      onChange={(e) => setEditFormData({ ...editFormData, storageLimit: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label">项目数限制</label>
                    <input
                      type="number"
                      min={1}
                      className="input w-full"
                      value={editFormData.projectLimit}
                      onChange={(e) => setEditFormData({ ...editFormData, projectLimit: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label">用户数限制</label>
                    <input
                      type="number"
                      min={1}
                      className="input w-full"
                      value={editFormData.userLimit}
                      onChange={(e) => setEditFormData({ ...editFormData, userLimit: Number(e.target.value) })}
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button type="button" onClick={() => setShowEditDialog(false)} className="btn flex-1">
                  取消
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary flex-1">
                  {saving ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="mb-8">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <Link href="/tenants" className="hover:text-primary-600">
            租户管理
          </Link>
          <span>/</span>
          <span>{tenant.name}</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{tenant.name}</h1>
            <p className="text-gray-500">租户 ID: {tenant.tenantId}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowEditDialog(true)} className="btn btn-primary">
              编辑租户
            </button>
            <button onClick={() => setShowDeleteDialog(true)} className="btn bg-red-600 text-white hover:bg-red-700">
              删除租户
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">别名</p>
            <p className="font-medium">{tenant.alias}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">套餐</p>
            <p className="font-medium capitalize">{tenant.plan}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">状态</p>
            <span
              className={`px-2 py-1 rounded text-xs ${
                tenant.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : tenant.status === 'suspended'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              {tenant.status === 'active' ? '活跃' : tenant.status === 'suspended' ? '已暂停' : tenant.status}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">存储限制</p>
            <p className="font-medium">{formatBytes(tenant.storageLimit)}</p>
          </div>
        </div>
      </div>

      {tenant.description && (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm text-gray-500 mb-1">描述</p>
            <p>{tenant.description}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="card-body text-center">
            <p className="text-3xl font-bold">{projects.length}</p>
            <p className="text-sm text-gray-500">/ {tenant.projectLimit} 项目</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body text-center">
            <p className="text-3xl font-bold">0</p>
            <p className="text-sm text-gray-500">/ {tenant.userLimit} 用户</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body text-center">
            <p className="text-3xl font-bold">0 B</p>
            <p className="text-sm text-gray-500">/ {formatBytes(tenant.storageLimit)} 存储</p>
          </div>
        </div>
      </div>

      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="font-semibold">项目列表</h2>
          <Link href={`/t/${tenantId}/projects/new`} className="btn btn-primary text-sm">
            创建项目
          </Link>
        </div>
        {projects.length === 0 ? (
          <div className="p-8 text-center text-gray-500">暂无项目</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>别名</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.projectId}>
                  <td className="font-medium">{project.name}</td>
                  <td className="text-gray-500">{project.alias}</td>
                  <td>
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        project.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {project.status === 'active' ? '活跃' : project.status}
                    </span>
                  </td>
                  <td>
                    <Link
                      href={`/t/${tenantId}/p/${project.projectId}`}
                      className="text-sm text-primary-600 hover:underline"
                    >
                      管理
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold">快速操作</h2>
        </div>
        <div className="card-body flex gap-3">
          <Link href={`/tenants/${tenantId}/backups`} className="btn btn-secondary">
            备份管理
          </Link>
          <Link href={`/tenants/${tenantId}/settings`} className="btn btn-secondary">
            租户设置
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
