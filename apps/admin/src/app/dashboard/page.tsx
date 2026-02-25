'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface Stats {
  tenants: number;
  users: number;
  backups: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({ tenants: 0, users: 0, backups: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const tenantsRes = await api.listTenants();
        setStats({
          tenants: tenantsRes.data?.length || 0,
          users: 0,
          backups: 0,
        });
      } finally {
        setLoading(false);
      }
    }
    fetchStats();
  }, []);

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">仪表板</h1>
        <p className="text-gray-500">欢迎使用 Druvia 管理控制台</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatCard
          title="租户数量"
          value={stats.tenants}
          icon="🏢"
          loading={loading}
        />
        <StatCard
          title="用户数量"
          value={stats.users}
          icon="👥"
          loading={loading}
        />
        <StatCard
          title="备份数量"
          value={stats.backups}
          icon="💾"
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">快速操作</h2>
          </div>
          <div className="card-body space-y-3">
            <a href="/tenants/new" className="btn btn-primary w-full">
              创建新租户
            </a>
            <a href="/tenants" className="btn btn-secondary w-full">
              管理租户
            </a>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">系统状态</h2>
          </div>
          <div className="card-body">
            <div className="space-y-2">
              <StatusItem label="API 服务" status="online" />
              <StatusItem label="数据库" status="online" />
              <StatusItem label="Hasura" status="online" />
              <StatusItem label="Redis" status="online" />
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function StatCard({
  title,
  value,
  icon,
  loading,
}: {
  title: string;
  value: number;
  icon: string;
  loading: boolean;
}) {
  return (
    <div className="card">
      <div className="card-body flex items-center gap-4">
        <div className="text-4xl">{icon}</div>
        <div>
          <p className="text-gray-500 text-sm">{title}</p>
          <p className="text-2xl font-bold">
            {loading ? '...' : value}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusItem({ label, status }: { label: string; status: 'online' | 'offline' }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-gray-600">{label}</span>
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${
          status === 'online'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700'
        }`}
      >
        {status === 'online' ? '正常' : '离线'}
      </span>
    </div>
  );
}
