# Admin 管理后台实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 Druvia Admin 管理后台的 MVP 功能，包括路由重构、动态导航、Schema 设计器和数据浏览器。

**Architecture:** Next.js 15 App Router + shadcn/ui + Zustand 状态管理，采用租户切换模式的三级路由结构。

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 4, shadcn/ui, Zustand, TanStack Table

---

## Phase 1: 基础设施 (Tasks 1-4)

### Task 1: 安装 shadcn/ui 和依赖

**Files:**
- Modify: `apps/admin/package.json`
- Create: `apps/admin/components.json`
- Create: `apps/admin/src/lib/utils.ts`

**Step 1: 安装 shadcn/ui CLI**

```bash
cd apps/admin && npx shadcn@latest init
```

选择配置:
- Style: Default
- Base color: Slate
- CSS variables: Yes

**Step 2: 安装核心组件**

```bash
npx shadcn@latest add button input select table dialog dropdown-menu tabs toast skeleton badge
```

**Step 3: 安装状态管理**

```bash
pnpm add zustand
```

**Step 4: 验证安装**

```bash
pnpm build
```

---

### Task 2: 创建全局状态管理

**Files:**
- Create: `apps/admin/src/store/app.ts`
- Create: `apps/admin/src/store/index.ts`

**Step 1: 创建 app store**

```typescript
// apps/admin/src/store/app.ts
import { create } from 'zustand';

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
}

interface Project {
  projectId: string;
  alias: string;
  name: string;
  schemaName: string;
}

interface AppState {
  // Current context
  currentTenant: Tenant | null;
  currentProject: Project | null;

  // Actions
  setCurrentTenant: (tenant: Tenant | null) => void;
  setCurrentProject: (project: Project | null) => void;
  clearContext: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentTenant: null,
  currentProject: null,

  setCurrentTenant: (tenant) => set({ currentTenant: tenant, currentProject: null }),
  setCurrentProject: (project) => set({ currentProject: project }),
  clearContext: () => set({ currentTenant: null, currentProject: null }),
}));
```

**Step 2: 创建 index 导出**

```typescript
// apps/admin/src/store/index.ts
export { useAppStore } from './app';
```

---

### Task 3: 创建路由结构

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/page.tsx`
- Create: `apps/admin/src/app/t/[tenantId]/projects/page.tsx`
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/page.tsx`
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`

**Step 1: 租户仪表板页面**

```typescript
// apps/admin/src/app/t/[tenantId]/page.tsx
'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

export default function TenantDashboardPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const { setCurrentTenant } = useAppStore();

  useEffect(() => {
    async function loadTenant() {
      const res = await api.getTenant(tenantId);
      if (res.success && res.data) {
        setCurrentTenant({
          tenantId: res.data.tenantId,
          alias: res.data.alias,
          name: res.data.name,
        });
      }
    }
    loadTenant();
  }, [tenantId, setCurrentTenant]);

  return (
    <DashboardLayout>
      <h1 className="text-2xl font-bold mb-4">租户概览</h1>
      <p className="text-gray-500">租户 ID: {tenantId}</p>
    </DashboardLayout>
  );
}
```

**Step 2: 项目列表页面**

```typescript
// apps/admin/src/app/t/[tenantId]/projects/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

export default function ProjectsPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadProjects() {
      const res = await api.listProjects(tenantId);
      if (res.success && res.data) {
        setProjects(res.data);
      }
      setLoading(false);
    }
    loadProjects();
  }, [tenantId]);

  return (
    <DashboardLayout>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">项目列表</h1>
        <Link
          href={`/t/${tenantId}/projects/new`}
          className="btn btn-primary"
        >
          新建项目
        </Link>
      </div>

      {loading ? (
        <p>加载中...</p>
      ) : projects.length === 0 ? (
        <p className="text-gray-500">暂无项目</p>
      ) : (
        <div className="grid gap-4">
          {projects.map((project) => (
            <Link
              key={project.projectId}
              href={`/t/${tenantId}/p/${project.projectId}`}
              className="card hover:shadow-md transition-shadow"
            >
              <div className="card-body">
                <h3 className="font-semibold">{project.name}</h3>
                <p className="text-sm text-gray-500">{project.alias}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
```

---

### Task 4: 动态侧边栏组件

**Files:**
- Modify: `apps/admin/src/components/Sidebar.tsx`
- Create: `apps/admin/src/components/Breadcrumb.tsx`

**Step 1: 安装图标库**

```bash
cd apps/admin && pnpm add lucide-react
```

---

## Phase 2: Schema 设计器 (Tasks 5-7)

### Task 5: 表列表页面
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`

### Task 6: 表结构编辑器
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx`

### Task 7: 新建表弹窗
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/new/page.tsx`

---

## Phase 3: 数据浏览器 (Tasks 8-10)

### Task 8: 数据表格组件
- Create: `apps/admin/src/components/DataBrowser.tsx`
- 依赖: `pnpm add @tanstack/react-table`

### Task 9: 行内编辑功能
- Create: `apps/admin/src/components/EditableCell.tsx`

### Task 10: 高级过滤器
- Create: `apps/admin/src/components/DataFilter.tsx`

---

## Phase 4: API 扩展 (Tasks 11-12)

### Task 11: 数据 CRUD API
- `GET /api/v1/schemas/:schema/tables/:table/rows`
- `POST /api/v1/schemas/:schema/tables/:table/rows`
- `PATCH /api/v1/schemas/:schema/tables/:table/rows/:id`
- `DELETE /api/v1/schemas/:schema/tables/:table/rows/:id`

### Task 12: 数据导出 API
- `GET /api/v1/schemas/:schema/tables/:table/export?format=csv|json`

---

## 验收标准

1. 路由结构符合设计
2. 侧边栏根据上下文动态切换
3. 可创建/编辑/删除表
4. 可查看/编辑/过滤数据
