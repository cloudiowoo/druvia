'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';

interface Stats {
  tenants: { total: number; weekNew: number };
  users: { total: number; weekNew: number };
  backups: { total: number; weekNew: number };
  storage: { used: number; total: number };
}

interface TrendData {
  date: string;
  tenants: number;
  users: number;
  backups: number;
}

interface Activity {
  id: string;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

interface ResourceUsage {
  topTenants: { name: string; size: number }[];
  storageByTenant: { name: string; size: number }[];
}

const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'];

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [trends, setTrends] = useState<TrendData[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [resources, setResources] = useState<ResourceUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, trendsRes, activitiesRes, resourcesRes] = await Promise.all([
          api.getDashboardStats(),
          api.getDashboardTrends(7),
          api.getDashboardActivities(10, 0),
          api.getDashboardResources(),
        ]);

        if (statsRes.success && statsRes.data) {
          setStats(statsRes.data);
        }
        if (trendsRes.success && trendsRes.data) {
          setTrends(trendsRes.data);
        }
        if (activitiesRes.success && activitiesRes.data) {
          setActivities(activitiesRes.data.activities);
        }
        if (resourcesRes.success && resourcesRes.data) {
          setResources(resourcesRes.data);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const getActionLabel = (action: string) => {
    const labels: Record<string, string> = {
      'user.login': '用户登录',
      'user.logout': '用户登出',
      'user.create': '创建用户',
      'user.update': '更新用户',
      'user.delete': '删除用户',
      'tenant.create': '创建租户',
      'tenant.update': '更新租户',
      'tenant.delete': '删除租户',
      'project.create': '创建项目',
      'project.delete': '删除项目',
      'backup.create': '创建备份',
      'backup.restore': '恢复备份',
      'backup.delete': '删除备份',
      'settings.update': '更新设置',
    };
    return labels[action] || action;
  };

  const storagePercent = stats ? Math.round((stats.storage.used / stats.storage.total) * 100) || 0 : 0;

  const chartTrends = trends.map((t) => ({
    ...t,
    date: t.date.slice(5),
  }));

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">仪表板</h1>
        <p className="text-gray-500">欢迎使用 Druvia 管理控制台</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="租户数量"
          value={stats?.tenants.total || 0}
          change={stats?.tenants.weekNew || 0}
          loading={loading}
        />
        <StatCard
          title="用户数量"
          value={stats?.users.total || 0}
          change={stats?.users.weekNew || 0}
          loading={loading}
        />
        <StatCard
          title="备份数量"
          value={stats?.backups.total || 0}
          change={stats?.backups.weekNew || 0}
          loading={loading}
        />
        <div className="card">
          <div className="card-body">
            <p className="text-gray-500 text-sm mb-2">存储使用</p>
            {loading ? (
              <p className="text-2xl font-bold">...</p>
            ) : (
              <>
                <p className="text-2xl font-bold">{formatBytes(stats?.storage.used || 0)}</p>
                <div className="mt-2">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary-500 transition-all"
                      style={{ width: `${storagePercent}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    共 {formatBytes(stats?.storage.total || 0)} ({storagePercent}%)
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Trends Chart */}
      <div className="card mb-8">
        <div className="card-header">
          <h2 className="font-semibold">7日趋势</h2>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="text-center text-gray-500 py-8">加载中...</div>
          ) : trends.length === 0 ? (
            <div className="text-center text-gray-500 py-8">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartTrends}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="tenants" name="租户" stroke="#6366f1" strokeWidth={2} />
                <Line type="monotone" dataKey="users" name="用户" stroke="#10b981" strokeWidth={2} />
                <Line type="monotone" dataKey="backups" name="备份" stroke="#f59e0b" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Activities & Resources */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Recent Activities */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">最近活动</h2>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="text-center text-gray-500 py-8">加载中...</div>
            ) : activities.length === 0 ? (
              <div className="text-center text-gray-500 py-8">暂无活动记录</div>
            ) : (
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex items-start gap-3 py-2 border-b last:border-0">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{getActionLabel(activity.action)}</p>
                      {activity.targetType && (
                        <p className="text-xs text-gray-500">
                          {activity.targetType}: {activity.targetId}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {formatDate(activity.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Storage Distribution */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">存储分布</h2>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="text-center text-gray-500 py-8">加载中...</div>
            ) : !resources || resources.storageByTenant.length === 0 ? (
              <div className="text-center text-gray-500 py-8">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={resources.storageByTenant.filter(t => t.size > 0)}
                    dataKey="size"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  >
                    {resources.storageByTenant.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatBytes(Number(value))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Top Tenants & System Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Top 5 Tenants */}
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="font-semibold">数据库大小 Top 5</h2>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="text-center text-gray-500 py-8">加载中...</div>
            ) : !resources || resources.topTenants.length === 0 ? (
              <div className="text-center text-gray-500 py-8">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={resources.topTenants} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(v) => formatBytes(v)} />
                  <YAxis type="category" dataKey="name" width={100} />
                  <Tooltip formatter={(value) => formatBytes(Number(value))} />
                  <Bar dataKey="size" fill="#6366f1" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* System Status */}
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

      {/* Quick Actions */}
      <div className="card">
        <div className="card-header">
          <h2 className="font-semibold">快速操作</h2>
        </div>
        <div className="card-body flex gap-3">
          <Link href="/tenants/new" className="btn btn-primary">
            创建新租户
          </Link>
          <Link href="/tenants" className="btn btn-secondary">
            管理租户
          </Link>
          <Link href="/backups" className="btn btn-secondary">
            备份管理
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}

function StatCard({
  title,
  value,
  change,
  loading,
}: {
  title: string;
  value: number;
  change: number;
  loading: boolean;
}) {
  return (
    <div className="card">
      <div className="card-body">
        <p className="text-gray-500 text-sm">{title}</p>
        <p className="text-2xl font-bold">
          {loading ? '...' : value}
        </p>
        {!loading && change > 0 && (
          <p className="text-xs text-green-600 mt-1">+{change} 本周新增</p>
        )}
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
