# 单租户模式 UI 优化实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 优化单租户模式下的前端界面，移除多租户相关元素，提供完整首页体验

**Architecture:** 通过条件渲染简化 UI，保持现有路由结构，复用 dashboard API 获取统计数据

**Tech Stack:** Next.js 14, React, TypeScript, Tailwind CSS, Recharts

---

## Task 1: Sidebar 导航文案调整

**Files:**
- Modify: `apps/admin/src/components/Sidebar.tsx:35-45`

**Step 1: 修改导航项文案**

将单租户模式下的「仪表板」改为「首页」：

```typescript
// apps/admin/src/components/Sidebar.tsx
// 修改 getGlobalNav 函数中的第一个导航项

const getGlobalNav = (): NavItem[] => {
  const multiTenant = isMultiTenantEnabled();
  const defaultTenant = getDefaultTenantId();

  const nav: NavItem[] = [
    {
      href: multiTenant ? '/dashboard' : `/t/${defaultTenant}`,
      label: multiTenant ? '仪表板' : '首页',  // ← 修改这里
      icon: <LayoutDashboard className="h-4 w-4" />
    },
  ];
  // ... rest unchanged
```

**Step 2: 验证改动**

启动开发服务器，确认 Sidebar 显示「首页」而非「仪表板」。

---

## Task 2: 首页重构 - 基础布局

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/page.tsx`

**Step 1: 添加状态和 API 调用**

```typescript
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

export default function TenantOverviewPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  const multiTenant = isMultiTenantEnabled();

  useEffect(() => {
    async function fetchData() {
      const [projectsRes, statsRes, activitiesRes] = await Promise.all([
        api.listProjects(tenantId),
        api.getDashboardStats(),
        api.getDashboardActivities(5, 0),
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
      setLoading(false);
    }
    fetchData();
  }, [tenantId]);

  // ... 继续 Step 2
```

**Step 2: 添加辅助函数和渲染逻辑**

```typescript
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
      'project.create': '创建项目',
      'backup.create': '创建备份',
    };
    return labels[action] || action;
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-4 gap-4">
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
        {/* 原有的多租户视图代码 */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{currentTenant?.name}</h1>
          <p className="text-muted-foreground">租户概览</p>
        </div>
        {/* ... 租户属性卡片和项目列表 */}
      </DashboardLayout>
    );
  }

  // 单租户模式：完整首页
  return (
    <DashboardLayout>
      {/* Step 3 中实现 */}
    </DashboardLayout>
  );
}
```

**Step 3: 实现单租户首页 UI**

```tsx
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
        <StatCard title="项目数" value={stats?.projects || 0} />
        <StatCard title="用户数" value={stats?.users || 0} />
        <StatCard title="备份数" value={stats?.backups || 0} />
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">存储使用</p>
          <p className="text-2xl font-bold">{formatBytes(stats?.storage.used || 0)}</p>
          <p className="text-xs text-muted-foreground">
            共 {formatBytes(stats?.storage.total || 0)}
          </p>
        </div>
      </div>

      {/* Projects List */}
      <div className="border rounded-lg mb-6">
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
        <div className="border rounded-lg">
          <div className="p-4 border-b">
            <h2 className="font-semibold">最近活动</h2>
          </div>
          <div className="p-4">
            {activities.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">暂无活动</p>
            ) : (
              <div className="space-y-3">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex justify-between text-sm">
                    <span>{getActionLabel(activity.action)}</span>
                    <span className="text-muted-foreground">{formatDate(activity.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* System Status */}
        <div className="border rounded-lg">
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

function StatCard({ title, value }: { title: string; value: number }) {
  return (
    <div className="border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
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
```

**Step 4: 验证改动**

启动开发服务器，访问 `/t/default`，确认：
- 显示「Druvia」标题和欢迎语
- 显示统计卡片
- 显示项目列表
- 显示最近活动和系统状态

---

## Task 3: 设置页简化

**Files:**
- Modify: `apps/admin/src/app/settings/page.tsx`

**Step 1: 添加租户模式判断**

在文件顶部导入：

```typescript
import { isMultiTenantEnabled } from '@/lib/tenant-config';
```

在组件内添加：

```typescript
const multiTenant = isMultiTenantEnabled();
```

**Step 2: 修改平台设置卡片**

将平台设置卡片的标题和内容根据模式条件渲染：

```tsx
{/* Platform Settings Card (Super Admin Only) */}
{isSuperAdmin && (
  <div className="card lg:col-span-2">
    <div className="card-header">
      <h2 className="font-semibold">{multiTenant ? '平台设置' : '系统设置'}</h2>
    </div>
    {loading ? (
      <div className="card-body text-center text-gray-500">加载中...</div>
    ) : settings ? (
      <div className="card-body">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 多租户模式才显示默认套餐 */}
          {multiTenant && (
            <div>
              <label className="label">默认套餐</label>
              <select
                className="input w-full"
                value={settings.defaultPlan}
                onChange={(e) => setSettings({ ...settings, defaultPlan: e.target.value })}
              >
                <option value="free">免费版</option>
                <option value="pro">专业版</option>
                <option value="enterprise">企业版</option>
              </select>
            </div>
          )}
          <div>
            <label className="label">{multiTenant ? '默认存储限制' : '存储限制'}</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                className="input w-full"
                value={settings.defaultStorageLimit / (1024 * 1024 * 1024)}
                onChange={(e) => setSettings({ ...settings, defaultStorageLimit: Number(e.target.value) * 1024 * 1024 * 1024 })}
              />
              <span className="text-gray-500">GB</span>
            </div>
          </div>
          {/* 多租户模式才显示项目数和用户数限制 */}
          {multiTenant && (
            <>
              <div>
                <label className="label">默认项目数限制</label>
                <input
                  type="number"
                  className="input w-full"
                  value={settings.defaultProjectLimit}
                  onChange={(e) => setSettings({ ...settings, defaultProjectLimit: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="label">默认用户数限制</label>
                <input
                  type="number"
                  className="input w-full"
                  value={settings.defaultUserLimit}
                  onChange={(e) => setSettings({ ...settings, defaultUserLimit: Number(e.target.value) })}
                />
              </div>
            </>
          )}
          <div>
            <label className="label">备份保留天数</label>
            <input
              type="number"
              className="input w-full"
              value={settings.backupRetentionDays}
              onChange={(e) => setSettings({ ...settings, backupRetentionDays: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="label">最大备份数量</label>
            <input
              type="number"
              className="input w-full"
              value={settings.backupMaxCount}
              onChange={(e) => setSettings({ ...settings, backupMaxCount: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="mt-6">
          <button onClick={handleSaveSettings} disabled={saving} className="btn btn-primary">
            {saving ? '保存中...' : multiTenant ? '保存平台设置' : '保存系统设置'}
          </button>
        </div>
      </div>
    ) : null}
  </div>
)}
```

**Step 3: 验证改动**

启动开发服务器，访问 `/settings`，确认：
- 卡片标题显示「系统设置」
- 隐藏「默认套餐」「默认项目数限制」「默认用户数限制」
- 保留「存储限制」「备份保留天数」「最大备份数量」

---

## Task 4: 验证与清理

**Step 1: 单租户模式功能验证**

1. 设置 `NEXT_PUBLIC_MULTI_TENANT_ENABLED=false`
2. 启动开发服务器
3. 验证以下场景：
   - 登录后跳转到 `/t/default`
   - 访问 `/dashboard` 重定向到 `/t/default`
   - 访问 `/tenants` 重定向到 `/t/default`
   - Sidebar 显示「首页」
   - 首页显示统计卡片、项目列表、最近活动、系统状态
   - 设置页显示「系统设置」，隐藏多租户配置项

**Step 2: 多租户模式回归测试**

1. 设置 `NEXT_PUBLIC_MULTI_TENANT_ENABLED=true`
2. 验证以下场景：
   - 登录后跳转到 `/tenants`
   - `/dashboard` 正常显示
   - Sidebar 显示「仪表板」和「租户管理」
   - 租户概览页显示租户属性卡片
   - 设置页显示「平台设置」，包含所有配置项

---

## 验收标准

- [ ] 单租户模式下 `/dashboard` 重定向到 `/t/default`
- [ ] 首页显示统计卡片、项目列表、最近活动、系统状态
- [ ] Sidebar 显示「首页」而非「仪表板」
- [ ] 设置页隐藏多租户相关配置项
- [ ] 多租户模式下行为不变

---

**更新日期**: 2026-03-08
