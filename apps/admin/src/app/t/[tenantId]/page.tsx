'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isMultiTenantEnabled } from '@/lib/tenant-config';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

interface Stats {
  projects: number;
  users: number;
  backups: number;
  storage: { used: number; total: number };
}

interface Activity {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
}

interface TrendData {
  date: string;
  users: number;
  backups: number;
}

const COLORS = ['#6366f1', '#e5e7eb'];

export default function TenantOverviewPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [trends, setTrends] = useState<TrendData[]>([]);
  const [loading, setLoading] = useState(true);

  const multiTenant = isMultiTenantEnabled();

  useEffect(() => {
    async function fetchData() {
      const [projectsRes, statsRes, activitiesRes, trendsRes] = await Promise.all([
        api.listProjects(tenantId),
        api.getDashboardStats(),
        api.getDashboardActivities(5, 0),
        api.getDashboardTrends(7),
      ]);

      if (projectsRes.success && projectsRes.data) {
        setProjects(projectsRes.data);
      }
      if (statsRes.success && statsRes.data) {
        setStats({
          projects: projectsRes.data?.length || 0,
          users: statsRes.data.users?.total || 0,
          backups: statsRes.data.backups?.total || 0,
          storage: statsRes.data.storage || { used: 0, total: 0 },
        });
      }
      if (activitiesRes.success && activitiesRes.data) {
        setActivities(activitiesRes.data.activities || []);
      }
      if (trendsRes.success && trendsRes.data) {
        setTrends(trendsRes.data);
      }
      setLoading(false);
    }
    fetchData();
  }, [tenantId]);

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
      'project.create': '创建项目',
      'project.delete': '删除项目',
      'backup.create': '创建备份',
      'backup.restore': '恢复备份',
    };
    return labels[action] || action;
  };

  const storagePercent = stats ? Math.round((stats.storage.used / stats.storage.total) * 100) || 0 : 0;
  const storageData = [
    { name: '已用', value: stats?.storage.used || 0 },
    { name: '可用', value: (stats?.storage.total || 0) - (stats?.storage.used || 0) },
  ];

  const chartTrends = trends.map((t) => ({
    ...t,
    date: t.date.slice(5),
  }));

  if (loading) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      </DashboardLayout>
    );
  }

  // 多租户模式：保持原有租户概览
  if (multiTenant) {
    return (
      <DashboardLayout>
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{currentTenant?.name}</h1>
          <p className="text-muted-foreground">租户概览</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">别名</p>
            <p className="font-medium">{currentTenant?.alias}</p>
          </div>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">套餐</p>
            <p className="font-medium capitalize">{currentTenant?.plan}</p>
          </div>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">状态</p>
            <Badge variant={currentTenant?.status === 'active' ? 'default' : 'secondary'}>
              {currentTenant?.status === 'active' ? '活跃' : currentTenant?.status}
            </Badge>
          </div>
        </div>

        <div className="border rounded-lg">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="font-semibold">项目列表</h2>
            <Button asChild size="sm">
              <Link href={`/t/${tenantId}/projects/new`}>创建项目</Link>
            </Button>
          </div>
          {projects.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">暂无项目</div>
          ) : (
            <div className="divide-y">
              {projects.map((project) => (
                <Link
                  key={project.projectId}
                  href={`/t/${tenantId}/p/${project.projectId}`}
                  className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <p className="font-medium">{project.name}</p>
                    <p className="text-sm text-muted-foreground">{project.alias}</p>
                  </div>
                  <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                    {project.status === 'active' ? '活跃' : project.status}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>
    );
  }

  // 单租户模式：完整首页
  return (
    <DashboardLayout>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Druvia</h1>
        <p className="text-muted-foreground">
          欢迎回来，{user?.username || user?.email}
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="项目数" value={stats?.projects || 0} icon="folder" />
        <StatCard title="用户数" value={stats?.users || 0} icon="users" />
        <StatCard title="备份数" value={stats?.backups || 0} icon="database" />
        <div className="border rounded-lg p-4 bg-white">
          <p className="text-sm text-muted-foreground mb-2">存储使用</p>
          <p className="text-2xl font-bold">{formatBytes(stats?.storage.used || 0)}</p>
          <div className="mt-2">
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              共 {formatBytes(stats?.storage.total || 0)} ({storagePercent}%)
            </p>
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Trends Chart */}
        <div className="border rounded-lg p-4 bg-white lg:col-span-2">
          <h2 className="font-semibold mb-4">7日趋势</h2>
          {chartTrends.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartTrends}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" fontSize={12} tickLine={false} />
                <YAxis fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="users"
                  name="用户"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="backups"
                  name="备份"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Storage Pie Chart */}
        <div className="border rounded-lg p-4 bg-white">
          <h2 className="font-semibold mb-4">存储分布</h2>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={storageData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={70}
              >
                {storageData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => formatBytes(Number(value))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 text-sm">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-indigo-500" />
              已用
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-gray-200" />
              可用
            </span>
          </div>
        </div>
      </div>

      {/* Projects List */}
      <div className="border rounded-lg mb-6 bg-white">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">我的项目</h2>
          <Button asChild size="sm">
            <Link href={`/t/${tenantId}/projects/new`}>创建项目</Link>
          </Button>
        </div>
        {projects.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">暂无项目</div>
        ) : (
          <div className="divide-y">
            {projects.map((project) => (
              <Link
                key={project.projectId}
                href={`/t/${tenantId}/p/${project.projectId}`}
                className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
              >
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-muted-foreground">{project.alias}</p>
                </div>
                <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                  {project.status === 'active' ? '活跃' : project.status}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Grid: Activities & System Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activities */}
        <div className="border rounded-lg bg-white">
          <div className="p-4 border-b">
            <h2 className="font-semibold">最近活动</h2>
          </div>
          <div className="p-4">
            {activities.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">暂无活动</p>
            ) : (
              <div className="space-y-3">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex justify-between text-sm py-1">
                    <span>{getActionLabel(activity.action)}</span>
                    <span className="text-muted-foreground">{formatDate(activity.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* System Status */}
        <div className="border rounded-lg bg-white">
          <div className="p-4 border-b">
            <h2 className="font-semibold">系统状态</h2>
          </div>
          <div className="p-4 space-y-2">
            <StatusItem label="API 服务" status="online" />
            <StatusItem label="数据库" status="online" />
            <StatusItem label="Hasura" status="online" />
            <StatusItem label="Redis" status="online" />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function StatCard({ title, value, icon }: { title: string; value: number; icon: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    folder: (
      <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
    users: (
      <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
    database: (
      <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
  };

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">{title}</p>
        {iconMap[icon]}
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function StatusItem({ label, status }: { label: string; status: 'online' | 'offline' }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${
          status === 'online' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}
      >
        {status === 'online' ? '正常' : '离线'}
      </span>
    </div>
  );
}
