'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
  plan: string;
  status: string;
  settings: Record<string, unknown>;
}

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

export default function TenantDetailPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [tenantRes, projectsRes] = await Promise.all([
          api.getTenant(tenantId),
          api.listProjects(tenantId),
        ]);

        if (tenantRes.success && tenantRes.data) {
          setTenant(tenantRes.data);
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
      <div className="mb-8">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <Link href="/tenants" className="hover:text-primary-600">
            租户管理
          </Link>
          <span>/</span>
          <span>{tenant.name}</span>
        </div>
        <h1 className="text-2xl font-bold">{tenant.name}</h1>
        <p className="text-gray-500">租户 ID: {tenant.tenantId}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">别名</p>
            <p className="font-medium">{tenant.alias}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">套餐</p>
            <p className="font-medium">{tenant.plan}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-sm text-gray-500">状态</p>
            <span
              className={`px-2 py-1 rounded text-xs ${
                tenant.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              {tenant.status === 'active' ? '活跃' : tenant.status}
            </span>
          </div>
        </div>
      </div>

      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="font-semibold">项目列表</h2>
          <Link
            href={`/t/${tenantId}/projects/new`}
            className="btn btn-primary text-sm"
          >
            创建项目
          </Link>
        </div>
        {projects.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            暂无项目
          </div>
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
          <Link
            href={`/tenants/${tenantId}/backups`}
            className="btn btn-secondary"
          >
            备份管理
          </Link>
          <Link
            href={`/tenants/${tenantId}/settings`}
            className="btn btn-secondary"
          >
            租户设置
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
