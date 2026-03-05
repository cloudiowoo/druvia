# Phase 3 P2 功能实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 4 个 P2 功能模块：外键关系配置、记录详情表单、JSON 单元格编辑器、侧边栏表列表

**Architecture:** 按依赖顺序实现 M11 → M14 → M13 → M12。后端已支持外键定义（`ColumnDefinition.references`），需扩展前端 UI 和添加外键管理 API。

**Tech Stack:** React 18, Next.js 14, react-hook-form, zod, @codemirror/lang-json, SVAR DataGrid

**相关文档:**
- [Phase 3 P2 设计文档](./2026-03-05-phase3-p2-design.md)

---

## 依赖安装

**Step 1: 安装依赖**

```bash
cd apps/admin && pnpm add react-hook-form zod @hookform/resolvers @codemirror/lang-json
```

**Step 2: 验证安装**

```bash
pnpm list react-hook-form zod @hookform/resolvers @codemirror/lang-json
```

Expected: 所有包显示已安装版本

---

## M11: 外键关系配置

### Task M11-1: 外键管理 API

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts`
- Modify: `apps/api/src/modules/table/table.routes.ts`
- Modify: `apps/api/src/modules/table/table.controller.ts`

**Step 1: 添加外键管理服务方法**

在 `apps/api/src/modules/table/table.service.ts` 末尾添加：

```typescript
// 获取表的外键详情（包含约束名和级联规则）
export interface ForeignKeyDetail {
  constraintName: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
  onUpdate: string;
}

export async function getTableForeignKeys(
  schemaName: string,
  tableName: string
): Promise<ForeignKeyDetail[]> {
  const result = await query<{
    constraint_name: string;
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    delete_rule: string;
    update_rule: string;
  }>(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       rc.delete_rule,
       rc.update_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, tableName]
  );

  return result.map(row => ({
    constraintName: row.constraint_name,
    fromColumn: row.column_name,
    toTable: row.foreign_table_name,
    toColumn: row.foreign_column_name,
    onDelete: row.delete_rule,
    onUpdate: row.update_rule,
  }));
}

// 添加外键约束
export async function addForeignKey(
  schemaName: string,
  tableName: string,
  config: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  }
): Promise<string> {
  // 验证标识符格式，防止 SQL 注入
  const identifierRegex = /^[a-z_][a-z0-9_]*$/i;
  if (!identifierRegex.test(schemaName) ||
      !identifierRegex.test(tableName) ||
      !identifierRegex.test(config.column) ||
      !identifierRegex.test(config.targetTable) ||
      !identifierRegex.test(config.targetColumn)) {
    throw new Error('Invalid identifier format');
  }

  const constraintName = `fk_${tableName}_${config.column}_${config.targetTable}`;
  const onDelete = config.onDelete || 'NO ACTION';
  const onUpdate = config.onUpdate || 'NO ACTION';

  // 验证级联规则是有效值
  const validActions = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION'];
  if (!validActions.includes(onDelete) || !validActions.includes(onUpdate)) {
    throw new Error('Invalid cascade action');
  }

  await pool.query(
    `ALTER TABLE "${schemaName}"."${tableName}"
     ADD CONSTRAINT "${constraintName}"
     FOREIGN KEY ("${config.column}")
     REFERENCES "${schemaName}"."${config.targetTable}"("${config.targetColumn}")
     ON DELETE ${onDelete}
     ON UPDATE ${onUpdate}`
  );

  return constraintName;
}

// 删除外键约束
export async function dropForeignKey(
  schemaName: string,
  tableName: string,
  constraintName: string
): Promise<void> {
  // 验证标识符格式，防止 SQL 注入
  const identifierRegex = /^[a-z_][a-z0-9_]*$/i;
  if (!identifierRegex.test(schemaName) ||
      !identifierRegex.test(tableName) ||
      !identifierRegex.test(constraintName)) {
    throw new Error('Invalid identifier format');
  }

  await pool.query(
    `ALTER TABLE "${schemaName}"."${tableName}" DROP CONSTRAINT "${constraintName}"`
  );
}
```

**Step 2: 添加路由**

在 `apps/api/src/modules/table/table.routes.ts` 添加：

```typescript
// 获取表外键
fastify.get<{
  Params: { schema: string; table: string };
}>('/schemas/:schema/tables/:table/foreign-keys', async (request, reply) => {
  const { schema, table } = request.params;
  const foreignKeys = await tableService.getTableForeignKeys(schema, table);
  return reply.send({ success: true, data: foreignKeys });
});

// 添加外键
fastify.post<{
  Params: { schema: string; table: string };
  Body: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}>('/schemas/:schema/tables/:table/foreign-keys', async (request, reply) => {
  const { schema, table } = request.params;
  const constraintName = await tableService.addForeignKey(schema, table, request.body);
  return reply.status(201).send({ success: true, data: { constraintName } });
});

// 删除外键
fastify.delete<{
  Params: { schema: string; table: string; name: string };
}>('/schemas/:schema/tables/:table/foreign-keys/:name', async (request, reply) => {
  const { schema, table, name } = request.params;
  await tableService.dropForeignKey(schema, table, name);
  return reply.send({ success: true });
});
```

**Step 3: 运行测试验证**

```bash
pnpm test -- --grep "foreign-key"
```

**Step 4: Commit**

```bash
git add apps/api/src/modules/table/
git commit -m "feat(api): add foreign key management API

- getTableForeignKeys: 获取表外键详情
- addForeignKey: 添加外键约束
- dropForeignKey: 删除外键约束

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M11-2: 前端 API 方法

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

**Step 1: 添加外键 API 方法**

```typescript
// Foreign Keys
async getTableForeignKeys(schemaName: string, tableName: string): Promise<ApiResponse<ForeignKeyDetail[]>> {
  return this.request('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys`);
}

async addForeignKey(
  schemaName: string,
  tableName: string,
  config: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  }
): Promise<ApiResponse<{ constraintName: string }>> {
  return this.request('POST', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys`, config);
}

async dropForeignKey(
  schemaName: string,
  tableName: string,
  constraintName: string
): Promise<ApiResponse<void>> {
  return this.request('DELETE', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys/${constraintName}`);
}
```

**Step 2: 添加类型定义**

```typescript
export interface ForeignKeyDetail {
  constraintName: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
  onUpdate: string;
}
```

**Step 3: Commit**

```bash
git add apps/admin/src/lib/api.ts
git commit -m "feat(admin): add foreign key API methods

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M11-3: 外键配置弹出框组件

**Files:**
- Create: `apps/admin/src/components/tables/ForeignKeyPopover.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link2, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';

interface ForeignKeyConfig {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

interface ForeignKeyPopoverProps {
  schemaName: string;
  columnName: string;
  columnType: string;
  existingFk?: ForeignKeyConfig;
  onAdd: (config: ForeignKeyConfig) => void;
  onRemove: () => void;
}

const CASCADE_OPTIONS = [
  { value: 'NO ACTION', label: 'NO ACTION' },
  { value: 'CASCADE', label: 'CASCADE' },
  { value: 'SET NULL', label: 'SET NULL' },
  { value: 'RESTRICT', label: 'RESTRICT' },
];

export function ForeignKeyPopover({
  schemaName,
  columnName,
  columnType,
  existingFk,
  onAdd,
  onRemove,
}: ForeignKeyPopoverProps) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<Array<{ tableName: string }>>([]);
  const [targetTable, setTargetTable] = useState(existingFk?.targetTable || '');
  const [targetColumns, setTargetColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [targetColumn, setTargetColumn] = useState(existingFk?.targetColumn || '');
  const [onDelete, setOnDelete] = useState<ForeignKeyConfig['onDelete']>(existingFk?.onDelete || 'NO ACTION');
  const [onUpdate, setOnUpdate] = useState<ForeignKeyConfig['onUpdate']>(existingFk?.onUpdate || 'NO ACTION');

  // 加载表列表
  useEffect(() => {
    if (open && schemaName) {
      api.listTables(schemaName).then(res => {
        if (res.success && res.data) {
          setTables(res.data);
        }
      });
    }
  }, [open, schemaName]);

  // 加载目标表的列
  useEffect(() => {
    if (targetTable && schemaName) {
      api.getTableStructure(schemaName, targetTable).then(res => {
        if (res.success && res.data) {
          // 只显示类型兼容的列
          const compatibleColumns = res.data.columns.filter(
            col => col.type.toLowerCase() === columnType.toLowerCase() || col.primaryKey
          );
          setTargetColumns(compatibleColumns);
        }
      });
    }
  }, [targetTable, schemaName, columnType]);

  const handleAdd = () => {
    if (targetTable && targetColumn) {
      onAdd({
        column: columnName,
        targetTable,
        targetColumn,
        onDelete,
        onUpdate,
      });
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={existingFk ? 'secondary' : 'ghost'}
          size="icon"
          className="h-6 w-6"
        >
          <Link2 className={`h-3 w-3 ${existingFk ? 'text-primary' : ''}`} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">外键配置</h4>
            {existingFk && (
              <Button variant="ghost" size="sm" onClick={onRemove}>
                <X className="h-4 w-4 mr-1" />
                移除
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">目标表</label>
            <Select value={targetTable} onValueChange={setTargetTable}>
              <SelectTrigger>
                <SelectValue placeholder="选择表" />
              </SelectTrigger>
              <SelectContent>
                {tables.map(t => (
                  <SelectItem key={t.tableName} value={t.tableName}>
                    {t.tableName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">目标列</label>
            <Select value={targetColumn} onValueChange={setTargetColumn} disabled={!targetTable}>
              <SelectTrigger>
                <SelectValue placeholder="选择列" />
              </SelectTrigger>
              <SelectContent>
                {targetColumns.map(c => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">ON DELETE</label>
              <Select value={onDelete} onValueChange={(v) => setOnDelete(v as ForeignKeyConfig['onDelete'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CASCADE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">ON UPDATE</label>
              <Select value={onUpdate} onValueChange={(v) => setOnUpdate(v as ForeignKeyConfig['onUpdate'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CASCADE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button onClick={handleAdd} disabled={!targetTable || !targetColumn} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            {existingFk ? '更新外键' : '添加外键'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/tables/ForeignKeyPopover.tsx
git commit -m "feat(admin): add ForeignKeyPopover component

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M11-4: 集成外键配置到建表对话框

**Files:**
- Modify: `apps/admin/src/components/CreateTableDialog.tsx`

**Step 1: 添加导入和扩展 Column 接口**

在文件顶部添加导入：

```typescript
import { ForeignKeyPopover } from '@/components/tables/ForeignKeyPopover';
```

扩展 Column 接口：

```typescript
interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string;
  // 新增外键配置
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
}
```

**Step 2: 在表格 thead 中添加外键列**

找到 `<thead>` 部分，在"主键"列后添加：

```tsx
<th className="text-center p-2 font-medium w-[60px]">外键</th>
```

**Step 3: 在表格 tbody 每行中添加外键配置单元格**

在每行的主键 checkbox 后、删除按钮前添加：

```tsx
<td className="p-2 text-center">
  <ForeignKeyPopover
    schemaName={schemaName}
    columnName={column.name}
    columnType={column.type}
    existingFk={column.references ? {
      column: column.name,
      targetTable: column.references.table,
      targetColumn: column.references.column,
      onDelete: column.references.onDelete || 'NO ACTION',
      onUpdate: column.references.onUpdate || 'NO ACTION',
    } : undefined}
    onAdd={(config) => {
      updateColumn(index, 'references', {
        table: config.targetTable,
        column: config.targetColumn,
        onDelete: config.onDelete,
        onUpdate: config.onUpdate,
      });
    }}
    onRemove={() => updateColumn(index, 'references', undefined)}
  />
</td>
```

**Step 4: 更新 handleCreate 传递外键配置**

修改 `handleCreate` 函数中的 API 调用：

```typescript
const res = await api.createTable(schemaName, {
  name: tableName,
  columns: validColumns.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    primaryKey: c.primaryKey,
    defaultValue: c.defaultValue,
    references: c.references,  // 传递外键配置
  })),
});
```

**Step 5: Commit**

```bash
git add apps/admin/src/components/CreateTableDialog.tsx
git commit -m "feat(admin): integrate foreign key config into CreateTableDialog

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## M14: 记录详情表单

### Task M14-1: 字段渲染器组件

**Files:**
- Create: `apps/admin/src/components/data/FieldRenderer.tsx`

**Step 1: 创建字段渲染器**

```typescript
'use client';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { Control, Controller } from 'react-hook-form';

interface FieldRendererProps {
  name: string;
  type: string;
  nullable: boolean;
  control: Control<Record<string, unknown>>;
  disabled?: boolean;
}

export function FieldRenderer({ name, type, nullable, control, disabled }: FieldRendererProps) {
  const baseType = type.toLowerCase().split('(')[0];

  // UUID 类型
  if (baseType === 'uuid') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <div className="flex gap-2">
            <Input {...field} value={field.value as string || ''} disabled={disabled} className="font-mono" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => field.onChange(crypto.randomUUID())}
              disabled={disabled}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        )}
      />
    );
  }

  // 布尔类型
  if (baseType === 'boolean') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Switch
            checked={field.value as boolean}
            onCheckedChange={field.onChange}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 数字类型
  if (['integer', 'bigint', 'smallint', 'numeric', 'decimal'].includes(baseType)) {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            {...field}
            value={field.value as number ?? ''}
            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 日期时间类型
  if (['timestamp', 'timestamptz', 'timestamp with time zone', 'timestamp without time zone'].includes(baseType)) {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="datetime-local"
            {...field}
            value={field.value ? String(field.value).slice(0, 16) : ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 日期类型
  if (baseType === 'date') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="date"
            {...field}
            value={field.value as string || ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // JSONB 类型 - 使用 Textarea，后续集成 M13 的 JSON 编辑器
  if (baseType === 'jsonb' || baseType === 'json') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Textarea
            {...field}
            value={typeof field.value === 'object' ? JSON.stringify(field.value, null, 2) : (field.value as string || '')}
            onChange={(e) => {
              try {
                field.onChange(JSON.parse(e.target.value));
              } catch {
                field.onChange(e.target.value);
              }
            }}
            disabled={disabled}
            className="font-mono min-h-[100px]"
          />
        )}
      />
    );
  }

  // 长文本类型
  if (baseType === 'text') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Textarea
            {...field}
            value={field.value as string || ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 默认：字符串输入
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <Input {...field} value={field.value as string || ''} disabled={disabled} />
      )}
    />
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/data/FieldRenderer.tsx
git commit -m "feat(admin): add FieldRenderer component for form fields

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M14-2: 外键下拉选择组件

**Files:**
- Create: `apps/admin/src/components/data/ForeignKeySelect.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Control, Controller } from 'react-hook-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Search } from 'lucide-react';

interface ForeignKeySelectProps {
  name: string;
  schemaName: string;
  targetTable: string;
  targetColumn: string;
  control: Control<Record<string, unknown>>;
  disabled?: boolean;
}

export function ForeignKeySelect({
  name,
  schemaName,
  targetTable,
  targetColumn,
  control,
  disabled,
}: ForeignKeySelectProps) {
  const [options, setOptions] = useState<Array<{ value: unknown; label: string }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchOptions = async () => {
      setLoading(true);
      try {
        const res = await api.listRows(schemaName, targetTable, { limit: 100 });
        if (res.success && res.data) {
          setOptions(
            res.data.rows.map((row: Record<string, unknown>) => ({
              value: row[targetColumn],
              label: String(row[targetColumn]),
            }))
          );
        }
      } finally {
        setLoading(false);
      }
    };
    fetchOptions();
  }, [schemaName, targetTable, targetColumn]);

  const filteredOptions = search
    ? options.filter(opt => String(opt.label).toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <Select
          value={field.value ? String(field.value) : ''}
          onValueChange={(v) => field.onChange(v || null)}
          disabled={disabled || loading}
        >
          <SelectTrigger>
            <SelectValue placeholder={loading ? '加载中...' : `选择 ${targetTable}`} />
          </SelectTrigger>
          <SelectContent>
            <div className="p-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <SelectItem value="">（空）</SelectItem>
            {filteredOptions.map((opt, i) => (
              <SelectItem key={i} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/data/ForeignKeySelect.tsx
git commit -m "feat(admin): add ForeignKeySelect component

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M14-3: 记录详情弹窗

**Files:**
- Create: `apps/admin/src/components/data/RecordFormDialog.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FieldRenderer } from './FieldRenderer';
import { ForeignKeySelect } from './ForeignKeySelect';
import { ForeignKeyDetail } from '@/lib/api';

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

interface RecordFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  tableName: string;
  columns: Column[];
  foreignKeys: ForeignKeyDetail[];
  record?: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  mode: 'create' | 'edit';
}

export function RecordFormDialog({
  open,
  onOpenChange,
  schemaName,
  tableName,
  columns,
  foreignKeys,
  record,
  onSave,
  mode,
}: RecordFormDialogProps) {
  // 动态构建 zod schema
  const schema = z.object(
    Object.fromEntries(
      columns.map(col => {
        let fieldSchema: z.ZodTypeAny = z.unknown();
        if (!col.nullable && !col.primaryKey) {
          fieldSchema = fieldSchema.refine(v => v !== null && v !== undefined && v !== '', {
            message: `${col.name} 不能为空`,
          });
        }
        return [col.name, fieldSchema];
      })
    )
  );

  const form = useForm<Record<string, unknown>>({
    resolver: zodResolver(schema),
    defaultValues: record || {},
  });

  useEffect(() => {
    if (record) {
      form.reset(record);
    } else {
      form.reset({});
    }
  }, [record, form]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    await onSave(data);
    onOpenChange(false);
  };

  // 获取列的外键配置
  const getForeignKey = (columnName: string) => {
    return foreignKeys.find(fk => fk.fromColumn === columnName);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新增记录' : '编辑记录'}</DialogTitle>
          <DialogDescription>
            {tableName} 表
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {columns.map(col => {
            const fk = getForeignKey(col.name);
            const isPk = col.primaryKey;

            return (
              <div key={col.name} className="space-y-2">
                <Label htmlFor={col.name} className="flex items-center gap-2">
                  {col.name}
                  <span className="text-xs text-muted-foreground">({col.type})</span>
                  {!col.nullable && <span className="text-destructive">*</span>}
                </Label>

                {fk ? (
                  <ForeignKeySelect
                    name={col.name}
                    schemaName={schemaName}
                    targetTable={fk.toTable}
                    targetColumn={fk.toColumn}
                    control={form.control}
                    disabled={isPk && mode === 'edit'}
                  />
                ) : (
                  <FieldRenderer
                    name={col.name}
                    type={col.type}
                    nullable={col.nullable}
                    control={form.control}
                    disabled={isPk && mode === 'edit'}
                  />
                )}

                {form.formState.errors[col.name] && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors[col.name]?.message as string}
                  </p>
                )}
              </div>
            );
          })}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/data/RecordFormDialog.tsx
git commit -m "feat(admin): add RecordFormDialog component

- Dynamic form based on table columns
- Foreign key dropdown support
- Zod validation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M14-4: 集成到数据网格

**Files:**
- Modify: `apps/admin/src/components/SvarDataGrid.tsx`

**Step 1: 添加导入**

```typescript
import { RecordFormDialog } from '@/components/data/RecordFormDialog';
import { ForeignKeyDetail } from '@/lib/api';
import { Edit } from 'lucide-react';
```

**Step 2: 添加状态**

在组件内添加：

```typescript
const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
const [formDialogOpen, setFormDialogOpen] = useState(false);
const [formMode, setFormMode] = useState<'create' | 'edit'>('edit');
const [foreignKeys, setForeignKeys] = useState<ForeignKeyDetail[]>([]);

// 加载外键信息
useEffect(() => {
  api.getTableForeignKeys(schemaName, tableName).then(res => {
    if (res.success && res.data) {
      setForeignKeys(res.data);
    }
  });
}, [schemaName, tableName]);
```

**Step 3: 添加编辑按钮到工具栏**

在"新增行"按钮后添加：

```tsx
{selectedRows.length === 1 && (
  <Button
    size="sm"
    variant="outline"
    onClick={() => {
      setEditingRecord(selectedRows[0]);
      setFormMode('edit');
      setFormDialogOpen(true);
    }}
  >
    <Edit className="h-4 w-4 mr-2" />
    编辑
  </Button>
)}
```

**Step 4: 修改新增行按钮打开表单**

```tsx
<Button size="sm" onClick={() => {
  setEditingRecord(null);
  setFormMode('create');
  setFormDialogOpen(true);
}}>
  <Plus className="h-4 w-4 mr-2" />
  新增行
</Button>
```

**Step 5: 添加 RecordFormDialog 渲染**

在组件 return 的最后（删除确认对话框后）添加：

```tsx
<RecordFormDialog
  open={formDialogOpen}
  onOpenChange={setFormDialogOpen}
  schemaName={schemaName}
  tableName={tableName}
  columns={tableStructure}
  foreignKeys={foreignKeys}
  record={editingRecord || undefined}
  mode={formMode}
  onSave={async (data) => {
    if (formMode === 'create') {
      await provider.handleEvent('add-row', { row: data });
    } else if (editingRecord) {
      const id = editingRecord[primaryKeyColumn];
      await provider.handleEvent('update-cell', { id, data });
    }
    fetchData();
  }}
/>
```

**Step 6: Commit**

```bash
git add apps/admin/src/components/SvarDataGrid.tsx
git commit -m "feat(admin): integrate RecordFormDialog into SvarDataGrid

- Add edit button for selected row
- Open form dialog for create/edit
- Load foreign keys for dropdown

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## M13: JSON 单元格编辑器

### Task M13-1: JSON 编辑器弹窗

**Files:**
- Create: `apps/admin/src/components/editors/JsonEditorDialog.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Check, Wand2 } from 'lucide-react';

interface JsonEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: unknown;
  onSave: (value: unknown) => void;
  title?: string;
}

export function JsonEditorDialog({
  open,
  onOpenChange,
  value,
  onSave,
  title = 'JSON 编辑器',
}: JsonEditorDialogProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      try {
        setCode(JSON.stringify(value, null, 2));
        setError(null);
      } catch {
        setCode(String(value));
      }
    }
  }, [open, value]);

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(code);
      setCode(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSave = () => {
    try {
      const parsed = JSON.parse(code);
      onSave(parsed);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 实时验证
  const handleChange = (newCode: string) => {
    setCode(newCode);
    try {
      JSON.parse(newCode);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {error ? (
                <span className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </span>
              ) : (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <Check className="h-4 w-4" />
                  有效的 JSON
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleFormat}>
              <Wand2 className="h-4 w-4 mr-2" />
              格式化
            </Button>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <CodeMirror
              value={code}
              height="400px"
              extensions={[json()]}
              onChange={handleChange}
              theme="light"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!!error}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/editors/JsonEditorDialog.tsx
git commit -m "feat(admin): add JsonEditorDialog with syntax highlighting

- CodeMirror with JSON language support
- Real-time validation
- Format button

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M13-2: JSON 预览组件

**Files:**
- Create: `apps/admin/src/components/editors/JsonPreview.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Expand } from 'lucide-react';
import { JsonEditorDialog } from './JsonEditorDialog';

interface JsonPreviewProps {
  value: unknown;
  onChange?: (value: unknown) => void;
  maxLength?: number;
}

export function JsonPreview({ value, onChange, maxLength = 50 }: JsonPreviewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const preview = (() => {
    try {
      const str = JSON.stringify(value);
      if (str.length > maxLength) {
        return str.slice(0, maxLength) + '...';
      }
      return str;
    } catch {
      return String(value);
    }
  })();

  return (
    <div className="flex items-center gap-2">
      <code className="text-sm bg-muted px-2 py-1 rounded truncate max-w-[200px]">
        {preview}
      </code>
      {onChange && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setDialogOpen(true)}
          >
            <Expand className="h-3 w-3" />
          </Button>
          <JsonEditorDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            value={value}
            onSave={onChange}
          />
        </>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/editors/JsonPreview.tsx
git commit -m "feat(admin): add JsonPreview component

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M13-3: 集成到 FieldRenderer

**Files:**
- Modify: `apps/admin/src/components/data/FieldRenderer.tsx`

**Step 1: 添加导入**

在文件顶部添加：

```typescript
import { JsonPreview } from '@/components/editors/JsonPreview';
```

**Step 2: 更新 JSONB 字段渲染**

将 JSONB 类型的 Textarea 替换为 JsonPreview + JsonEditorDialog：

```typescript
// JSONB 类型 - 使用 JSON 编辑器
if (baseType === 'jsonb' || baseType === 'json') {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <JsonPreview
          value={field.value}
          onChange={disabled ? undefined : field.onChange}
        />
      )}
    />
  );
}
```

**Step 3: Commit**

```bash
git add apps/admin/src/components/data/FieldRenderer.tsx
git commit -m "feat(admin): integrate JsonPreview into FieldRenderer

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## M12: 侧边栏表列表

### Task M12-1: TableSidebar 组件

**Files:**
- Create: `apps/admin/src/components/tables/TableSidebar.tsx`

**Step 1: 创建组件**

```typescript
'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Table2, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TableInfo {
  tableName: string;
  rowCount: number;
}

interface TableSidebarProps {
  tables: TableInfo[];
  currentTable?: string;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function TableSidebar({
  tables,
  currentTable,
  collapsed = false,
  onCollapsedChange,
}: TableSidebarProps) {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const [search, setSearch] = useState('');

  const filteredTables = useMemo(() => {
    if (!search) return tables;
    return tables.filter(t =>
      t.tableName.toLowerCase().includes(search.toLowerCase())
    );
  }, [tables, search]);

  if (collapsed) {
    return (
      <div className="w-10 border-r bg-muted/30 flex flex-col items-center py-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapsedChange?.(false)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="mt-4 text-xs text-muted-foreground writing-vertical">
          {tables.length} 表
        </div>
      </div>
    );
  }

  return (
    <div className="w-56 border-r bg-muted/30 flex flex-col">
      {/* 头部 */}
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-sm font-medium">数据表</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onCollapsedChange?.(true)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>

      {/* 搜索框 */}
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索表..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>

      {/* 表列表 */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {filteredTables.map((table) => (
            <Link
              key={table.tableName}
              href={`/t/${tenantId}/p/${projectId}/tables/${table.tableName}/data`}
            >
              <div
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                  currentTable === table.tableName
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                <Table2 className="h-4 w-4 flex-shrink-0" />
                <span className="truncate flex-1">{table.tableName}</span>
                <span className="text-xs opacity-60">
                  {table.rowCount.toLocaleString()}
                </span>
              </div>
            </Link>
          ))}

          {filteredTables.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-4">
              {search ? '未找到匹配的表' : '暂无数据表'}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 底部统计 */}
      <div className="p-2 border-t text-xs text-muted-foreground text-center">
        共 {tables.length} 张表
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/tables/TableSidebar.tsx
git commit -m "feat(admin): add TableSidebar component

- Search filter
- Current table highlight
- Collapsible sidebar
- Row count display

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task M12-2: 集成到数据浏览页面

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx`

**Step 1: 添加侧边栏**

```typescript
// 导入
import { TableSidebar } from '@/components/tables/TableSidebar';

// 添加状态
const [tables, setTables] = useState<Array<{ tableName: string; rowCount: number }>>([]);
const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

// 加载表列表
useEffect(() => {
  if (currentProject?.schemaName) {
    api.listTables(currentProject.schemaName).then(res => {
      if (res.success && res.data) {
        setTables(res.data);
      }
    });
  }
}, [currentProject?.schemaName]);

// 修改布局
return (
  <DashboardLayout>
    <div className="flex h-[calc(100vh-64px)]">
      <TableSidebar
        tables={tables}
        currentTable={tableName}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />
      <div className="flex-1 overflow-auto p-6">
        {/* 原有内容 */}
      </div>
    </div>
  </DashboardLayout>
);
```

**Step 2: Commit**

```bash
git add apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx
git commit -m "feat(admin): integrate TableSidebar into data browser page

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## 验收测试

### 手动测试清单

**M11 外键关系配置:**
- [ ] 建表时可配置外键
- [ ] 外键弹出框显示目标表和列
- [ ] 级联规则可选择
- [ ] 创建表后外键约束生效

**M14 记录详情表单:**
- [ ] 双击行打开编辑弹窗
- [ ] 所有字段类型正确渲染
- [ ] 外键字段显示下拉选择
- [ ] 表单验证正常工作
- [ ] 保存后数据更新

**M13 JSON 单元格编辑器:**
- [ ] JSON 语法高亮
- [ ] 格式化按钮工作
- [ ] 实时语法验证
- [ ] 保存有效 JSON

**M12 侧边栏表列表:**
- [ ] 显示所有表
- [ ] 搜索过滤工作
- [ ] 点击切换表
- [ ] 当前表高亮
- [ ] 可折叠

---

**创建日期**: 2026-03-05
**审查日期**: 2026-03-05 (第 2 轮)
**状态**: 已审查，待实施
