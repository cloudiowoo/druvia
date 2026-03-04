# Phase 1 实施计划：表数据 CRUD + 快速建表模板

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 增强表数据管理体验，支持行内编辑和模板快速建表

**Architecture:** 集成 SVAR DataGrid + 自定义 DruviaDataProvider 适配层；扩展 CreateTableDialog 支持预设模板

**Tech Stack:** React 18+, @svar-ui/react-grid, TypeScript

---

## 外部依赖

| 包名 | 版本 | 许可证 | 用途 |
|------|------|--------|------|
| @svar-ui/react-grid | ^2.5.2 | MIT | 表格组件（虚拟滚动、行内编辑） |
| @svar-ui/lib-state | ^2.5.2 | MIT | 状态管理（Grid 事件处理） |

---

## 现有代码分析

| 组件 | 位置 | 现状 |
|------|------|------|
| DataTable | `apps/admin/src/components/DataTable.tsx` | ✅ 基础表格（将被 SVAR Grid 替换） |
| CreateTableDialog | `apps/admin/src/components/CreateTableDialog.tsx` | ✅ 手动建表，默认字段 |
| 数据浏览页 | `apps/admin/src/app/t/.../tables/[tableName]/data/page.tsx` | ✅ 查看、删除、导出 |
| Row API | `apps/admin/src/lib/api.ts` | ✅ listRows, createRow, updateRow, deleteRow |

## 需要新增

| 功能 | 说明 |
|------|------|
| DruviaDataProvider | 适配层，转换 API 调用格式 |
| SVAR Grid 集成 | 替换现有 DataTable，支持行内编辑 |
| 模板建表 | 预设 5 个常用表模板 |

---

## Task 1: 安装 SVAR DataGrid 依赖

**Step 1: 安装包**

```bash
cd apps/admin && pnpm add @svar-ui/react-grid @svar-ui/lib-state
```

**Step 2: 验证安装**

```bash
pnpm list @svar-ui/react-grid
```

Expected: 显示已安装版本

---

## Task 2: 创建 DruviaDataProvider 适配层

**Files:**
- Create: `apps/admin/src/lib/druvia-data-provider.ts`

**Step 1: 创建适配层**

```typescript
// apps/admin/src/lib/druvia-data-provider.ts
import { api } from './api';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string | null;
}

export interface DataProviderOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: FilterCondition[];
}

export interface FilterCondition {
  column: string;
  operator: string;
  value: unknown;
}

/**
 * DruviaDataProvider - 适配 SVAR DataGrid 与 Druvia API
 *
 * 解决的兼容性问题：
 * 1. 响应格式：Druvia 返回 { success, data } vs SVAR 期望直接数据
 * 2. 更新操作：Druvia 用 body { primaryKey, data } vs SVAR 用 URL /:id
 * 3. 删除操作：Druvia 用 body { primaryKey } vs SVAR 用 URL /:id
 */
export class DruviaDataProvider {
  constructor(
    private schemaName: string,
    private tableName: string,
    private primaryKeyColumn: string = 'id'
  ) {}

  /**
   * 获取数据 - 转换响应格式
   */
  async getData(options?: DataProviderOptions): Promise<{
    rows: Record<string, unknown>[];
    total: number;
    columns: ColumnInfo[];
  }> {
    const res = await api.listRows(this.schemaName, this.tableName, {
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
      orderBy: options?.orderBy,
      orderDir: options?.orderDir,
      filters: options?.filters,
    });

    if (!res.success || !res.data) {
      throw new Error(res.error?.message || 'Failed to load data');
    }

    return {
      rows: res.data.rows,
      total: res.data.total,
      columns: res.data.columns,
    };
  }

  /**
   * 处理 Grid 事件 - 转换为 Druvia API 调用
   */
  async handleEvent(
    event: 'add-row' | 'update-row' | 'update-cell' | 'delete-row',
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> {
    switch (event) {
      case 'add-row':
        return this.addRow(payload.row as Record<string, unknown>);

      case 'update-row':
      case 'update-cell':
        return this.updateRow(
          payload.id as unknown,
          (payload.row || payload.data) as Record<string, unknown>
        );

      case 'delete-row':
        return this.deleteRow(payload.id as unknown);

      default:
        console.warn(`Unknown event: ${event}`);
    }
  }

  private async addRow(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await api.createRow(this.schemaName, this.tableName, row);
    if (!res.success) {
      throw new Error(res.error?.message || 'Create failed');
    }
    return res.data as Record<string, unknown>;
  }

  private async updateRow(
    id: unknown,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.updateRow(this.schemaName, this.tableName, primaryKey, data);
    if (!res.success) {
      throw new Error(res.error?.message || 'Update failed');
    }
    return res.data as Record<string, unknown>;
  }

  private async deleteRow(id: unknown): Promise<void> {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.deleteRow(this.schemaName, this.tableName, primaryKey);
    if (!res.success) {
      throw new Error(res.error?.message || 'Delete failed');
    }
  }

  /**
   * 批量删除
   */
  async deleteRows(ids: unknown[]): Promise<number> {
    const primaryKeys = ids.map((id) => ({ [this.primaryKeyColumn]: id }));
    const res = await api.deleteRows(this.schemaName, this.tableName, primaryKeys);
    if (!res.success) {
      throw new Error(res.error?.message || 'Batch delete failed');
    }
    return res.data?.deleted ?? 0;
  }
}
```

**Step 2: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

Expected: 无错误

---

## Task 3: 创建 SVAR Grid 包装组件

**Files:**
- Create: `apps/admin/src/components/SvarDataGrid.tsx`

**Step 1: 创建包装组件（保留分页/排序/筛选功能）**

```tsx
// apps/admin/src/components/SvarDataGrid.tsx
'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Grid } from '@svar-ui/react-grid';
import '@svar-ui/react-grid/all.css';
import { DruviaDataProvider, ColumnInfo, DataProviderOptions } from '@/lib/druvia-data-provider';
import { Button } from '@/components/ui/button';
import { AdvancedFilter, FilterCondition, FilterBadges } from '@/components/AdvancedFilter';
import {
  Plus,
  Trash2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

// PostgreSQL 类型 → SVAR 编辑器映射
function getEditor(pgType: string): string | undefined {
  const typeMap: Record<string, string> = {
    'varchar': 'text',
    'text': 'text',
    'integer': 'text',
    'bigint': 'text',
    'boolean': 'checkbox',
    'date': 'datepicker',
    'timestamp': 'datepicker',
    'timestamptz': 'datepicker',
  };
  const baseType = pgType.split('(')[0].toLowerCase();
  return typeMap[baseType];
}

interface SvarDataGridProps {
  schemaName: string;
  tableName: string;
  primaryKeyColumn?: string;
  pageSize?: number;
  onError?: (error: Error) => void;
}

export function SvarDataGrid({
  schemaName,
  tableName,
  primaryKeyColumn = 'id',
  pageSize = 50,
  onError,
}: SvarDataGridProps) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedRows, setSelectedRows] = useState<unknown[]>([]);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const gridRef = useRef<any>(null);

  const provider = useMemo(
    () => new DruviaDataProvider(schemaName, tableName, primaryKeyColumn),
    [schemaName, tableName, primaryKeyColumn]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const options: DataProviderOptions = {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        orderBy,
        orderDir,
        filters: filters.length > 0 ? filters : undefined,
      };
      const result = await provider.getData(options);
      setData(result.rows);
      setColumns(result.columns);
      setTotal(result.total);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Load failed'));
    } finally {
      setLoading(false);
    }
  }, [provider, page, pageSize, orderBy, orderDir, filters, onError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalPages = Math.ceil(total / pageSize);

  // 转换列定义为 SVAR 格式（支持排序）
  const gridColumns = useMemo(() => {
    return columns.map((col) => ({
      id: col.name,
      header: col.name,
      editor: getEditor(col.type),
      width: col.name === 'id' ? 80 : undefined,
      flexgrow: col.name !== 'id' ? 1 : undefined,
      sort: true, // 启用排序
    }));
  }, [columns]);

  // Grid 初始化 - 绑定事件处理
  const init = useCallback((api: any) => {
    gridRef.current = api;

    // 监听排序事件
    api.on('sort', (ev: any) => {
      if (ev.column) {
        setOrderBy(ev.column);
        setOrderDir(ev.dir || 'asc');
        setPage(1);
      } else {
        setOrderBy(undefined);
        setOrderDir('asc');
      }
    });

    // 监听行更新事件
    api.on('update-cell', async (ev: any) => {
      try {
        await provider.handleEvent('update-cell', {
          id: ev.row[primaryKeyColumn],
          data: { [ev.column]: ev.value },
        });
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error('Update failed'));
        fetchData();
      }
    });

    // 监听选择变化
    api.on('select-row', (ev: any) => {
      setSelectedRows(ev.selected || []);
    });
  }, [provider, primaryKeyColumn, onError, fetchData]);

  // 筛选变化
  const handleFiltersChange = (newFilters: FilterCondition[]) => {
    setFilters(newFilters);
    setPage(1);
  };

  const handleRemoveFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
    setPage(1);
  };

  // 新增行
  const handleAddRow = async () => {
    try {
      const newRow = await provider.handleEvent('add-row', { row: {} });
      if (newRow) {
        fetchData(); // 刷新以保持分页一致性
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Add failed'));
    }
  };

  // 删除选中行
  const handleDeleteSelected = async () => {
    if (selectedRows.length === 0) return;
    try {
      await provider.deleteRows(selectedRows);
      setSelectedRows([]);
      fetchData();
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Delete failed'));
    }
  };

  if (loading && data.length === 0) {
    return <div className="p-4 text-center text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleAddRow}>
            <Plus className="h-4 w-4 mr-2" />
            新增行
          </Button>
          {selectedRows.length > 0 && (
            <Button size="sm" variant="destructive" onClick={handleDeleteSelected}>
              <Trash2 className="h-4 w-4 mr-2" />
              删除选中 ({selectedRows.length})
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <AdvancedFilter
            columns={columns}
            filters={filters}
            onFiltersChange={handleFiltersChange}
          />
          <Button size="sm" variant="outline" onClick={fetchData}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 筛选标签 */}
      {filters.length > 0 && (
        <FilterBadges filters={filters} onRemove={handleRemoveFilter} />
      )}

      {/* SVAR Grid */}
      <div style={{ height: 500 }}>
        <Grid
          data={data}
          columns={gridColumns}
          init={init}
          select="row"
          multiselect={true}
          autoRowHeight={false}
        />
      </div>

      {/* 分页控件 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          共 {total.toLocaleString()} 条记录
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(1)}
            disabled={page === 1}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm px-2">
            第 {page} / {totalPages || 1} 页
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

---

## Task 4: 更新数据浏览页面使用 SVAR Grid

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx`

**Step 1: 替换 DataTable 为 SvarDataGrid**

将现有的 DataTable 组件替换为新的 SvarDataGrid：

```tsx
// 替换导入
import { SvarDataGrid } from '@/components/SvarDataGrid';

// 在 return 中替换 DataTable
<SvarDataGrid
  schemaName={currentProject.schemaName}
  tableName={tableName}
  primaryKeyColumn="id"
  onError={(err) => console.error(err)}
/>
```

**Step 2: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

---

## Task 5: 添加表模板定义

**Files:**
- Create: `apps/admin/src/lib/table-templates.ts`

**Step 1: 创建模板定义文件**

```typescript
// apps/admin/src/lib/table-templates.ts

export interface TableTemplate {
  id: string;
  name: string;
  description: string;
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    defaultValue?: string;
  }>;
}

export const TABLE_TEMPLATES: TableTemplate[] = [
  {
    id: 'users',
    name: '用户表',
    description: '用户账号信息，包含邮箱、用户名、密码哈希等',
    tableName: 'users',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'email', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'username', type: 'varchar(100)', nullable: true, primaryKey: false },
      { name: 'password_hash', type: 'text', nullable: false, primaryKey: false },
      { name: 'avatar_url', type: 'text', nullable: true, primaryKey: false },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'active'" },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'posts',
    name: '文章表',
    description: '博客文章或内容，包含标题、正文、作者等',
    tableName: 'posts',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'title', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'slug', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'content', type: 'text', nullable: true, primaryKey: false },
      { name: 'author_id', type: 'uuid', nullable: true, primaryKey: false },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'draft'" },
      { name: 'published_at', type: 'timestamptz', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'orders',
    name: '订单表',
    description: '电商订单，包含订单号、金额、状态等',
    tableName: 'orders',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'order_no', type: 'varchar(50)', nullable: false, primaryKey: false },
      { name: 'user_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'total_amount', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'pending'" },
      { name: 'paid_at', type: 'timestamptz', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'products',
    name: '产品表',
    description: '产品目录，包含名称、价格、库存等',
    tableName: 'products',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'name', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'description', type: 'text', nullable: true, primaryKey: false },
      { name: 'price', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'stock', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'category', type: 'varchar(100)', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'comments',
    name: '评论表',
    description: '通用评论，支持多态关联',
    tableName: 'comments',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'content', type: 'text', nullable: false, primaryKey: false },
      { name: 'user_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'target_type', type: 'varchar(50)', nullable: false, primaryKey: false },
      { name: 'target_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
];
```

**Step 2: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

Expected: 无错误

---

## Task 6: 增强 CreateTableDialog 支持模板选择

**Files:**
- Modify: `apps/admin/src/components/CreateTableDialog.tsx`

**Step 1: 导入模板**

在文件顶部添加：

```tsx
import { TABLE_TEMPLATES } from '@/lib/table-templates';
```

**Step 2: 添加模板选择状态**

在组件内添加：

```tsx
const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
const [createMode, setCreateMode] = useState<'blank' | 'template'>('blank');
```

**Step 3: 添加模板应用函数**

```tsx
const applyTemplate = (templateId: string) => {
  const template = TABLE_TEMPLATES.find(t => t.id === templateId);
  if (template) {
    setTableName(template.tableName);
    setColumns(template.columns.map(c => ({ ...c })));
    setSelectedTemplate(templateId);
  }
};
```

**Step 4: 修改 resetForm 函数**

```tsx
const resetForm = () => {
  setTableName('');
  setColumns([...DEFAULT_COLUMNS]);
  setError(null);
  setSelectedTemplate(null);
  setCreateMode('blank');
};
```

**Step 5: 在表单中添加模板选择 UI**

在 DialogContent 内，表名输入框之前添加：

```tsx
{/* 创建模式选择 */}
<div className="flex gap-2 mb-4">
  <Button
    type="button"
    variant={createMode === 'blank' ? 'default' : 'outline'}
    size="sm"
    onClick={() => {
      setCreateMode('blank');
      setSelectedTemplate(null);
      setColumns([...DEFAULT_COLUMNS]);
      setTableName('');
    }}
  >
    空白表
  </Button>
  <Button
    type="button"
    variant={createMode === 'template' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setCreateMode('template')}
  >
    从模板创建
  </Button>
</div>

{/* 模板选择 */}
{createMode === 'template' && (
  <div className="mb-4">
    <label className="text-sm font-medium mb-2 block">选择模板</label>
    <div className="grid grid-cols-2 gap-2">
      {TABLE_TEMPLATES.map((template) => (
        <button
          key={template.id}
          type="button"
          onClick={() => applyTemplate(template.id)}
          className={`p-3 text-left border rounded-lg hover:border-primary transition-colors ${
            selectedTemplate === template.id ? 'border-primary bg-primary/5' : ''
          }`}
        >
          <div className="font-medium text-sm">{template.name}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {template.description}
          </div>
        </button>
      ))}
    </div>
  </div>
)}
```

**Step 6: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

Expected: 无错误

---

## Task 7: 端到端测试

**Step 1: 启动开发服务器**

```bash
pnpm dev
```
（用户手动执行）

**Step 2: 测试 SVAR Grid 功能**

1. 登录管理后台
2. 进入租户 > 项目 > 数据表 > 选择一个表 > 数据
3. 验证 SVAR Grid 正确显示数据
4. 双击单元格，验证行内编辑功能
5. 点击「新增行」，验证新增功能
6. 选中多行，点击「删除选中」，验证批量删除

**Step 3: 测试模板建表**

1. 点击「新建表」
2. 选择「从模板创建」
3. 选择「用户表」模板
4. 验证表名和字段自动填充
5. 点击「创建表」
6. 验证表创建成功

---

## 验收标准

### M1 表数据 CRUD
- [x] SVAR Grid 正确显示数据（虚拟滚动）
- [x] 可行内编辑数据
- [x] 可新增行
- [x] 可批量删除行
- [x] 支持服务端分页（保留现有功能）
- [x] 支持服务端排序（保留现有功能）
- [x] 支持服务端筛选（保留现有功能）
- [x] DruviaDataProvider 正确转换 API 调用
- [x] 时区问题修复（日期选择不偏移）
- [x] 时间编辑器支持（timestamp 可输入时间）

### M2 快速建表模板
- [x] 可选择预设模板
- [x] 模板自动填充表名和字段
- [x] 支持 5 种常用模板

---

**创建日期**: 2026-03-02
**更新日期**: 2026-03-02
**状态**: ✅ 已完成
