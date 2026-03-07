# Phase 5 P2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement data generator, form validation, single-tenant mode, MCP integration, and environment management for Druvia.

**Architecture:** Five modules - M6 uses faker.js with dynamic import for test data generation; M15 creates shared zod schemas for form validation; M21 adds environment variable toggle for single-tenant mode; M16 creates standalone MCP server package with API key auth; M10 implements dev/prod schema isolation.

**Tech Stack:** @faker-js/faker, zod, @modelcontextprotocol/sdk, react-hook-form

---

## Module 1: M6 Data Generator

### Task 1: Install faker.js dependency

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: Install @faker-js/faker**

Run:
```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm add @faker-js/faker
```

**Step 2: Verify installation**

Run:
```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm list @faker-js/faker
```
Expected: `@faker-js/faker 9.x.x`

---

### Task 2: Create faker mapping utility

**Files:**
- Create: `apps/admin/src/lib/faker-mapping.ts`

**Step 1: Create the mapping utility**

```typescript
// apps/admin/src/lib/faker-mapping.ts

export interface FakerRule {
  type: string;
  label: string;
  generate: (faker: any) => unknown;
}

export const FAKER_RULES: Record<string, FakerRule> = {
  email: {
    type: 'email',
    label: '邮箱',
    generate: (faker) => faker.internet.email(),
  },
  username: {
    type: 'username',
    label: '用户名',
    generate: (faker) => faker.internet.username(),
  },
  name: {
    type: 'name',
    label: '姓名',
    generate: (faker) => faker.person.fullName(),
  },
  title: {
    type: 'title',
    label: '标题',
    generate: (faker) => faker.lorem.sentence(),
  },
  content: {
    type: 'content',
    label: '内容',
    generate: (faker) => faker.lorem.paragraphs(1),
  },
  description: {
    type: 'description',
    label: '描述',
    generate: (faker) => faker.lorem.paragraph(),
  },
  integer: {
    type: 'integer',
    label: '整数',
    generate: (faker) => faker.number.int({ min: 1, max: 1000 }),
  },
  boolean: {
    type: 'boolean',
    label: '布尔值',
    generate: (faker) => faker.datatype.boolean(),
  },
  uuid: {
    type: 'uuid',
    label: 'UUID',
    generate: (faker) => faker.string.uuid(),
  },
  timestamp: {
    type: 'timestamp',
    label: '时间戳',
    generate: (faker) => faker.date.recent().toISOString(),
  },
  date: {
    type: 'date',
    label: '日期',
    generate: (faker) => faker.date.recent().toISOString().split('T')[0],
  },
  url: {
    type: 'url',
    label: 'URL',
    generate: (faker) => faker.internet.url(),
  },
  phone: {
    type: 'phone',
    label: '电话',
    generate: (faker) => faker.phone.number(),
  },
  text: {
    type: 'text',
    label: '文本',
    generate: (faker) => faker.lorem.sentence(),
  },
};

// 根据列名和类型推断 Faker 规则
export function inferFakerRule(columnName: string, columnType: string): string {
  const name = columnName.toLowerCase();

  // 按列名匹配
  if (name.includes('email')) return 'email';
  if (name.includes('username') || name === 'user_name') return 'username';
  if (name.includes('name') && !name.includes('username')) return 'name';
  if (name.includes('title')) return 'title';
  if (name.includes('content') || name.includes('body')) return 'content';
  if (name.includes('description') || name.includes('desc')) return 'description';
  if (name.includes('url') || name.includes('link')) return 'url';
  if (name.includes('phone') || name.includes('tel')) return 'phone';

  // 按类型匹配
  const type = columnType.toLowerCase();
  if (type.includes('uuid')) return 'uuid';
  if (type.includes('int') || type.includes('serial')) return 'integer';
  if (type.includes('bool')) return 'boolean';
  if (type.includes('timestamp') || type.includes('time')) return 'timestamp';
  if (type.includes('date')) return 'date';
  if (type.includes('text') || type.includes('varchar') || type.includes('char')) return 'text';

  return 'text'; // 默认
}
```

---

### Task 3: Create DataGeneratorDialog component

**Files:**
- Create: `apps/admin/src/components/data/DataGeneratorDialog.tsx`

**Step 1: Create the dialog component**

```typescript
// apps/admin/src/components/data/DataGeneratorDialog.tsx
'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, CheckCircle, Wand2 } from 'lucide-react';
import { api } from '@/lib/api';
import { FAKER_RULES, inferFakerRule } from '@/lib/faker-mapping';

interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  references?: {
    table: string;
    column: string;
  };
}

interface DataGeneratorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  tableName: string;
  columns: Column[];
  onSuccess?: () => void;
}

type GeneratorStatus = 'idle' | 'generating' | 'preview' | 'inserting' | 'done' | 'error';

interface ColumnRule {
  columnName: string;
  ruleType: string;
  skip: boolean;
}

export function DataGeneratorDialog({
  open,
  onOpenChange,
  schemaName,
  tableName,
  columns,
  onSuccess,
}: DataGeneratorDialogProps) {
  const [status, setStatus] = useState<GeneratorStatus>('idle');
  const [count, setCount] = useState(10);
  const [rules, setRules] = useState<ColumnRule[]>([]);
  const [previewData, setPreviewData] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inserted: number; errors: number } | null>(null);
  const [foreignKeyData, setForeignKeyData] = useState<Record<string, unknown[]>>({});

  // 初始化规则
  useEffect(() => {
    if (open && columns.length > 0) {
      const initialRules = columns
        .filter(col => !col.name.endsWith('_at') && col.name !== 'id') // 跳过时间戳和主键
        .map(col => ({
          columnName: col.name,
          ruleType: col.references ? 'foreign_key' : inferFakerRule(col.name, col.type),
          skip: false,
        }));
      setRules(initialRules);
      setStatus('idle');
      setPreviewData([]);
      setError(null);
      setResult(null);
    }
  }, [open, columns]);

  // 加载外键关联数据
  useEffect(() => {
    if (open) {
      const fkColumns = columns.filter(col => col.references);
      fkColumns.forEach(async (col) => {
        if (col.references) {
          try {
            const res = await api.listRows(schemaName, col.references.table, { limit: 100 });
            if (res.success && res.data?.rows) {
              setForeignKeyData(prev => ({
                ...prev,
                [col.name]: res.data.rows.map((r: Record<string, unknown>) => r[col.references!.column]),
              }));
            }
          } catch {
            // 静默处理
          }
        }
      });
    }
  }, [open, columns, schemaName]);

  const handleGenerate = useCallback(async () => {
    setStatus('generating');
    setError(null);

    try {
      // 动态导入 faker
      const { faker } = await import('@faker-js/faker');

      const data: Record<string, unknown>[] = [];

      for (let i = 0; i < count; i++) {
        const row: Record<string, unknown> = {};

        for (const rule of rules) {
          if (rule.skip) continue;

          if (rule.ruleType === 'foreign_key') {
            const fkValues = foreignKeyData[rule.columnName];
            if (fkValues && fkValues.length > 0) {
              row[rule.columnName] = fkValues[Math.floor(Math.random() * fkValues.length)];
            }
          } else {
            const fakerRule = FAKER_RULES[rule.ruleType];
            if (fakerRule) {
              row[rule.columnName] = fakerRule.generate(faker);
            }
          }
        }

        data.push(row);
      }

      setPreviewData(data);
      setStatus('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
      setStatus('error');
    }
  }, [count, rules, foreignKeyData]);

  const handleInsert = async () => {
    setStatus('inserting');
    setError(null);

    try {
      const res = await api.post(
        `/api/v1/schemas/${schemaName}/tables/${tableName}/import`,
        { rows: previewData, options: { onError: 'skip', batchSize: 100 } }
      );

      setResult({ inserted: res.data.imported, errors: res.data.skipped });
      setStatus('done');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '插入失败');
      setStatus('error');
    }
  };

  const updateRule = (columnName: string, ruleType: string) => {
    setRules(prev =>
      prev.map(r => (r.columnName === columnName ? { ...r, ruleType } : r))
    );
  };

  const toggleSkip = (columnName: string) => {
    setRules(prev =>
      prev.map(r => (r.columnName === columnName ? { ...r, skip: !r.skip } : r))
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            生成测试数据 - {tableName}
          </DialogTitle>
        </DialogHeader>

        {status === 'idle' && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="count">生成数量</Label>
              <Input
                id="count"
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(Math.min(100, Math.max(1, parseInt(e.target.value) || 10)))}
              />
              <p className="text-sm text-muted-foreground mt-1">最多 100 条</p>
            </div>

            <div>
              <Label>字段规则</Label>
              <div className="space-y-2 mt-2">
                {rules.map((rule) => (
                  <div key={rule.columnName} className="flex items-center gap-4">
                    <div className="w-32 font-mono text-sm">{rule.columnName}</div>
                    <Select
                      value={rule.ruleType}
                      onValueChange={(v) => updateRule(rule.columnName, v)}
                      disabled={rule.skip}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {rule.ruleType === 'foreign_key' && (
                          <SelectItem value="foreign_key">外键引用</SelectItem>
                        )}
                        {Object.entries(FAKER_RULES).map(([key, r]) => (
                          <SelectItem key={key} value={key}>{r.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant={rule.skip ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => toggleSkip(rule.columnName)}
                    >
                      {rule.skip ? '已跳过' : '跳过'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {status === 'generating' && (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
              <p>正在生成数据...</p>
            </div>
          </div>
        )}

        {status === 'preview' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">预览数据（{previewData.length} 条）</h3>
              <Button variant="outline" size="sm" onClick={() => setStatus('idle')}>
                重新配置
              </Button>
            </div>
            <div className="border rounded overflow-x-auto max-h-60">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    {rules.filter(r => !r.skip).map(r => (
                      <th key={r.columnName} className="px-3 py-2 text-left font-medium">
                        {r.columnName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.slice(0, 10).map((row, idx) => (
                    <tr key={idx} className="border-t">
                      {rules.filter(r => !r.skip).map(r => (
                        <td key={r.columnName} className="px-3 py-2 truncate max-w-[200px]">
                          {String(row[r.columnName] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewData.length > 10 && (
              <p className="text-sm text-muted-foreground">显示前 10 条，共 {previewData.length} 条</p>
            )}
          </div>
        )}

        {status === 'inserting' && (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
              <p>正在插入数据...</p>
            </div>
          </div>
        )}

        {status === 'done' && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">插入完成</span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">成功</div>
                <div className="text-2xl font-bold">{result.inserted}</div>
              </div>
              <div>
                <div className="text-muted-foreground">失败</div>
                <div className="text-2xl font-bold">{result.errors}</div>
              </div>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          {status === 'idle' && (
            <Button onClick={handleGenerate}>生成预览</Button>
          )}
          {status === 'preview' && (
            <Button onClick={handleInsert}>确认插入</Button>
          )}
          {(status === 'done' || status === 'error') && (
            <Button onClick={() => onOpenChange(false)}>关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

### Task 4: Add generator button to data page

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx`

**Step 1: Import DataGeneratorDialog**

Add import at top of file:
```typescript
import { DataGeneratorDialog } from '@/components/data/DataGeneratorDialog';
```

**Step 2: Add state for dialog**

Add after line 31 (`const [importOpen, setImportOpen] = useState(false);`):
```typescript
const [generatorOpen, setGeneratorOpen] = useState(false);
```

**Step 3: Add button to toolbar**

Add after the "导入 CSV" button (around line 126):
```typescript
<Button variant="outline" size="sm" onClick={() => setGeneratorOpen(true)}>
  <Wand2 className="h-4 w-4 mr-2" />
  生成测试数据
</Button>
```

**Step 4: Add Wand2 icon import**

Update lucide-react import to include Wand2:
```typescript
import { ArrowLeft, Download, Upload, Wand2 } from 'lucide-react';
```

**Step 5: Add dialog component**

Add after CsvImportDialog (around line 168):
```typescript
<DataGeneratorDialog
  open={generatorOpen}
  onOpenChange={setGeneratorOpen}
  schemaName={currentProject.schemaName}
  tableName={tableName}
  columns={columns}
  onSuccess={() => {
    setGridKey(Date.now());
    toast({
      title: '生成成功',
      description: '测试数据已成功插入',
    });
  }}
/>
```

---

## Module 2: M15 Form Validation Enhancement

### Task 5: Create shared zod schemas

**Files:**
- Create: `apps/admin/src/lib/schemas/index.ts`

**Step 1: Create schemas directory and file**

```typescript
// apps/admin/src/lib/schemas/index.ts
import { z } from 'zod';

// 列名验证：小写字母或下划线开头，只含小写字母、数字、下划线
export const columnNameSchema = z.string()
  .min(1, '列名不能为空')
  .max(63, '列名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '列名只能包含小写字母、数字和下划线，且以字母或下划线开头');

// 表名验证
export const tableNameSchema = z.string()
  .min(1, '表名不能为空')
  .max(63, '表名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '表名只能包含小写字母、数字和下划线，且以字母或下划线开头');

// 项目名验证
export const projectNameSchema = z.string()
  .min(1, '项目名不能为空')
  .max(100, '项目名最长 100 字符')
  .trim();

// 项目 ID 验证
export const projectIdSchema = z.string()
  .min(1, '项目 ID 不能为空')
  .max(50, '项目 ID 最长 50 字符')
  .regex(/^[a-z0-9_-]+$/, '项目 ID 只能包含小写字母、数字、下划线和连字符');

// 列定义 schema
export const columnSchema = z.object({
  name: columnNameSchema,
  type: z.string().min(1, '请选择列类型'),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().optional(),
  references: z.object({
    table: z.string(),
    column: z.string(),
    onDelete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
    onUpdate: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
  }).optional(),
});

// 创建表 schema
export const createTableSchema = z.object({
  tableName: tableNameSchema,
  columns: z.array(columnSchema).min(1, '至少需要一个列'),
});

// 创建项目 schema
export const createProjectSchema = z.object({
  name: projectNameSchema,
  projectId: projectIdSchema,
  description: z.string().max(500, '描述最长 500 字符').optional(),
});

export type ColumnInput = z.infer<typeof columnSchema>;
export type CreateTableInput = z.infer<typeof createTableSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
```

---

### Task 6: Refactor CreateTableDialog with zod

**Files:**
- Modify: `apps/admin/src/components/CreateTableDialog.tsx`

**Step 1: Add imports**

Add at top of file:
```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createTableSchema, columnNameSchema, type CreateTableInput } from '@/lib/schemas';
```

**Step 2: Add form validation for table name**

Replace the table name validation in handleCreate function. Find the existing validation:
```typescript
if (!tableName.trim()) {
  setError('请输入表名');
  return;
}
```

Replace with:
```typescript
const tableNameResult = columnNameSchema.safeParse(tableName);
if (!tableNameResult.success) {
  setError(tableNameResult.error.errors[0].message);
  return;
}
```

**Step 3: Add column name validation**

In the column name input onChange handler, add validation feedback. Find the column name Input and wrap with validation:

```typescript
// Add validation state
const [columnErrors, setColumnErrors] = useState<Record<number, string>>({});

// In validateColumnName function (add this function)
const validateColumnName = (index: number, name: string) => {
  const result = columnNameSchema.safeParse(name);
  if (!result.success) {
    setColumnErrors(prev => ({ ...prev, [index]: result.error.errors[0].message }));
  } else {
    setColumnErrors(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }
};
```

**Step 4: Display validation errors**

Add error display below column name input:
```typescript
{columnErrors[index] && (
  <p className="text-xs text-destructive mt-1">{columnErrors[index]}</p>
)}
```

---

### Task 6.1: Refactor EditTableDialog with zod

**Files:**
- Modify: `apps/admin/src/components/EditTableDialog.tsx`

**Step 1: Add imports**

Add at top of file:
```typescript
import { columnNameSchema } from '@/lib/schemas';
```

**Step 2: Add column name validation**

Apply same validation pattern as CreateTableDialog for new column names.

---

### Task 6.2: Refactor CreateProjectDialog with zod

**Files:**
- Modify: `apps/admin/src/components/CreateProjectDialog.tsx`

**Step 1: Add imports**

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createProjectSchema, type CreateProjectInput } from '@/lib/schemas';
```

**Step 2: Use react-hook-form with zodResolver**

```typescript
const form = useForm<CreateProjectInput>({
  resolver: zodResolver(createProjectSchema),
  defaultValues: {
    name: '',
    projectId: '',
    description: '',
  },
});
```

---

## Module 3: M21 Single-Tenant Mode

### Task 7: Add environment variables

**Files:**
- Modify: `apps/admin/.env.example`
- Modify: `apps/admin/.env.local` (if exists)

**Step 1: Add to .env.example**

```bash
# Single-tenant mode (set to true to enable multi-tenant)
NEXT_PUBLIC_MULTI_TENANT_ENABLED=false
NEXT_PUBLIC_DEFAULT_TENANT_ID=default
```

---

### Task 8: Create tenant config utility

**Files:**
- Create: `apps/admin/src/lib/tenant-config.ts`

**Step 1: Create config file**

```typescript
// apps/admin/src/lib/tenant-config.ts

export const tenantConfig = {
  multiTenantEnabled: process.env.NEXT_PUBLIC_MULTI_TENANT_ENABLED === 'true',
  defaultTenantId: process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID || 'default',
};

export function isMultiTenantEnabled(): boolean {
  return tenantConfig.multiTenantEnabled;
}

export function getDefaultTenantId(): string {
  return tenantConfig.defaultTenantId;
}
```

---

### Task 9: Update middleware for single-tenant redirect

**Files:**
- Modify: `apps/admin/src/middleware.ts`

**Step 1: Read current middleware**

First, check the current middleware implementation.

**Step 2: Add single-tenant redirect logic**

Add after authentication check:
```typescript
import { tenantConfig } from '@/lib/tenant-config';

// In middleware function, after auth check:
if (!tenantConfig.multiTenantEnabled) {
  // Single-tenant mode: redirect to default tenant
  if (pathname === '/tenants' || pathname === '/') {
    return NextResponse.redirect(new URL(`/t/${tenantConfig.defaultTenantId}/dashboard`, request.url));
  }
}
```

---

### Task 10: Update DashboardLayout to hide tenant selector

**Files:**
- Modify: `apps/admin/src/components/DashboardLayout.tsx`

**Step 1: Import tenant config**

```typescript
import { isMultiTenantEnabled } from '@/lib/tenant-config';
```

**Step 2: Conditionally render tenant selector**

Find the tenant selector/switcher component and wrap with condition:
```typescript
{isMultiTenantEnabled() && (
  // existing tenant selector JSX
)}
```

---

### Task 11: Create default tenant migration

**Files:**
- Create: `migrations/007_create_default_tenant.sql`

**Step 1: Create migration file**

```sql
-- migrations/007_create_default_tenant.sql
-- Create default tenant for single-tenant mode

INSERT INTO druvia_tenants (tenant_id, name, created_at)
VALUES ('default', 'Default Tenant', NOW())
ON CONFLICT (tenant_id) DO NOTHING;
```

---

## Module 4: M16 MCP Integration

### Task 12: Create API Key database table

**Files:**
- Create: `migrations/008_create_api_keys.sql`

**Step 1: Create migration**

```sql
-- migrations/008_create_api_keys.sql
-- API Keys for MCP and external integrations

CREATE TABLE IF NOT EXISTS druvia_api_keys (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  key_hash VARCHAR(64) NOT NULL,
  key_prefix VARCHAR(12) NOT NULL,
  name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(key_hash)
);

CREATE INDEX idx_api_keys_project ON druvia_api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON druvia_api_keys(key_hash);
```

---

### Task 13: Create API Key service

**Files:**
- Create: `apps/api/src/modules/api-keys/api-keys.service.ts`

**Step 1: Create service**

```typescript
// apps/api/src/modules/api-keys/api-keys.service.ts
import { pool } from '../../db';
import crypto from 'crypto';

export interface ApiKey {
  id: number;
  projectId: string;
  keyPrefix: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateApiKeyResult {
  key: string; // Full key, only returned once
  apiKey: ApiKey;
}

function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(24);
  return `dru_${randomBytes.toString('base64url')}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(projectId: string, name?: string): Promise<CreateApiKeyResult> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const keyPrefix = key.substring(0, 12);

  const result = await pool.query(
    `INSERT INTO druvia_api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, key_prefix, name, created_at, last_used_at`,
    [projectId, keyHash, keyPrefix, name || null]
  );

  return {
    key,
    apiKey: {
      id: result.rows[0].id,
      projectId: result.rows[0].project_id,
      keyPrefix: result.rows[0].key_prefix,
      name: result.rows[0].name,
      createdAt: result.rows[0].created_at,
      lastUsedAt: result.rows[0].last_used_at,
    },
  };
}

export async function listApiKeys(projectId: string): Promise<ApiKey[]> {
  const result = await pool.query(
    `SELECT id, project_id, key_prefix, name, created_at, last_used_at
     FROM druvia_api_keys
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );

  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    keyPrefix: row.key_prefix,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function deleteApiKey(id: number, projectId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM druvia_api_keys WHERE id = $1 AND project_id = $2`,
    [id, projectId]
  );
  return result.rowCount > 0;
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; projectId?: string }> {
  const keyHash = hashApiKey(key);

  const result = await pool.query(
    `UPDATE druvia_api_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1
     RETURNING project_id`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    return { valid: false };
  }

  return { valid: true, projectId: result.rows[0].project_id };
}
```

---

### Task 14: Create API Key routes

**Files:**
- Create: `apps/api/src/modules/api-keys/api-keys.routes.ts`

**Step 1: Create routes**

```typescript
// apps/api/src/modules/api-keys/api-keys.routes.ts
import { FastifyInstance } from 'fastify';
import { createApiKey, listApiKeys, deleteApiKey } from './api-keys.service';

export async function apiKeysRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/api-keys
  fastify.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/api-keys',
    async (request, reply) => {
      const { projectId } = request.params;
      const keys = await listApiKeys(projectId);
      return reply.send({ success: true, data: keys });
    }
  );

  // POST /api/v1/projects/:projectId/api-keys
  fastify.post<{ Params: { projectId: string }; Body: { name?: string } }>(
    '/projects/:projectId/api-keys',
    async (request, reply) => {
      const { projectId } = request.params;
      const { name } = request.body || {};
      const result = await createApiKey(projectId, name);
      return reply.status(201).send({ success: true, data: result });
    }
  );

  // DELETE /api/v1/projects/:projectId/api-keys/:keyId
  fastify.delete<{ Params: { projectId: string; keyId: string } }>(
    '/projects/:projectId/api-keys/:keyId',
    async (request, reply) => {
      const { projectId, keyId } = request.params;
      const deleted = await deleteApiKey(parseInt(keyId), projectId);
      if (!deleted) {
        return reply.status(404).send({ success: false, error: 'API Key not found' });
      }
      return reply.send({ success: true });
    }
  );
}
```

**Step 2: Register routes in app**

Add to `apps/api/src/index.ts`:
```typescript
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes';

// Register routes
app.register(apiKeysRoutes, { prefix: '/api/v1' });
```

---

### Task 15: Create API Keys management page

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/api-keys/page.tsx`

**Step 1: Create the page**

```typescript
// apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/api-keys/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Key, Plus, Trash2, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

interface ApiKey {
  id: number;
  keyPrefix: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function ApiKeysPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { toast } = useToast();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const loadKeys = async () => {
    try {
      const res = await api.get(`/api/v1/projects/${projectId}/api-keys`);
      if (res.data.success) {
        setKeys(res.data.data);
      }
    } catch {
      toast({ title: '加载失败', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, [projectId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await api.post(`/api/v1/projects/${projectId}/api-keys`, {
        name: newKeyName || undefined,
      });
      if (res.data.success) {
        setNewKey(res.data.data.key);
        loadKeys();
      }
    } catch {
      toast({ title: '创建失败', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await api.delete(`/api/v1/projects/${projectId}/api-keys/${deleteId}`);
      loadKeys();
      toast({ title: '已删除' });
    } catch {
      toast({ title: '删除失败', variant: 'destructive' });
    } finally {
      setDeleteId(null);
    }
  };

  const copyKey = async () => {
    if (newKey) {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setNewKeyName('');
    setNewKey(null);
    setShowKey(false);
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Key className="h-6 w-6" />
              API Keys
            </h1>
            <p className="text-muted-foreground">管理项目的 API 访问密钥</p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            创建 API Key
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">加载中...</div>
        ) : keys.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            暂无 API Key，点击上方按钮创建
          </div>
        ) : (
          <div className="border rounded-lg divide-y">
            {keys.map((key) => (
              <div key={key.id} className="p-4 flex items-center justify-between">
                <div>
                  <div className="font-mono text-sm">{key.keyPrefix}...</div>
                  {key.name && <div className="text-sm text-muted-foreground">{key.name}</div>}
                  <div className="text-xs text-muted-foreground mt-1">
                    创建于 {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt && ` · 最后使用 ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setDeleteId(key.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Create Dialog */}
        <Dialog open={createOpen} onOpenChange={closeCreateDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{newKey ? '保存你的 API Key' : '创建 API Key'}</DialogTitle>
            </DialogHeader>

            {!newKey ? (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">名称（可选）</label>
                  <Input
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="例如：MCP Server"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  请立即复制此 API Key，关闭后将无法再次查看完整密钥。
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={newKey}
                    readOnly
                    className="font-mono"
                  />
                  <Button variant="outline" size="icon" onClick={() => setShowKey(!showKey)}>
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button variant="outline" size="icon" onClick={copyKey}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter>
              {!newKey ? (
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? '创建中...' : '创建'}
                </Button>
              ) : (
                <Button onClick={closeCreateDialog}>完成</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除</AlertDialogTitle>
              <AlertDialogDescription>
                删除后，使用此 API Key 的应用将无法访问。此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
```

---

### Task 16: Create MCP Server package

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@druvia/mcp",
  "version": "0.1.0",
  "description": "MCP Server for Druvia - enables AI assistants to interact with Druvia",
  "main": "dist/index.js",
  "bin": {
    "druvia-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=18"
  },
  "keywords": ["mcp", "druvia", "ai", "claude"],
  "license": "MIT"
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 3: Create src/index.ts**

```typescript
#!/usr/bin/env node
// packages/mcp-server/src/index.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.DRUVIA_API_URL || 'http://localhost:3001';
const API_KEY = process.env.DRUVIA_API_KEY;

if (!API_KEY) {
  console.error('Error: DRUVIA_API_KEY environment variable is required');
  process.exit(1);
}

async function apiRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

const server = new McpServer({
  name: 'druvia-mcp',
  version: '0.1.0',
});

// List tables
server.tool(
  'list_tables',
  'List all tables in a schema',
  { schemaName: z.string().describe('The schema name') },
  async ({ schemaName }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables`);
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// Get table schema
server.tool(
  'get_table_schema',
  'Get the structure of a table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
  },
  async ({ schemaName, tableName }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables/${tableName}`);
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// Query data
server.tool(
  'query_data',
  'Query data from a table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    limit: z.number().optional().describe('Maximum rows to return'),
    offset: z.number().optional().describe('Number of rows to skip'),
  },
  async ({ schemaName, tableName, limit = 20, offset = 0 }) => {
    const result = await apiRequest(
      `/api/v1/schemas/${schemaName}/tables/${tableName}/rows?limit=${limit}&offset=${offset}`
    );
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// Insert row
server.tool(
  'insert_row',
  'Insert a new row into a table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    data: z.record(z.unknown()).describe('The row data as key-value pairs'),
  },
  async ({ schemaName, tableName, data }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables/${tableName}/rows`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Update row
server.tool(
  'update_row',
  'Update an existing row in a table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    primaryKey: z.record(z.unknown()).describe('Primary key to identify the row'),
    data: z.record(z.unknown()).describe('The data to update'),
  },
  async ({ schemaName, tableName, primaryKey, data }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables/${tableName}/rows`, {
      method: 'PATCH',
      body: JSON.stringify({ primaryKey, data }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Delete row
server.tool(
  'delete_row',
  'Delete a row from a table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    primaryKey: z.record(z.unknown()).describe('Primary key to identify the row'),
  },
  async ({ schemaName, tableName, primaryKey }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables/${tableName}/rows`, {
      method: 'DELETE',
      body: JSON.stringify({ primaryKey }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Create table
server.tool(
  'create_table',
  'Create a new table',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    columns: z.array(z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean().optional(),
      primaryKey: z.boolean().optional(),
    })).describe('Column definitions'),
  },
  async ({ schemaName, tableName, columns }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables`, {
      method: 'POST',
      body: JSON.stringify({ tableName, columns }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Alter table
server.tool(
  'alter_table',
  'Modify table structure',
  {
    schemaName: z.string().describe('The schema name'),
    tableName: z.string().describe('The table name'),
    operations: z.array(z.object({
      type: z.enum(['add_column', 'drop_column', 'rename_column']),
      column: z.string().optional(),
      newName: z.string().optional(),
      columnType: z.string().optional(),
    })).describe('Operations to perform'),
  },
  async ({ schemaName, tableName, operations }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/tables/${tableName}`, {
      method: 'PATCH',
      body: JSON.stringify({ operations }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Execute SQL
server.tool(
  'execute_sql',
  'Execute a SQL query',
  {
    schemaName: z.string().describe('The schema name'),
    sql: z.string().describe('The SQL query to execute'),
  },
  async ({ schemaName, sql }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/sql/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// List buckets
server.tool(
  'list_buckets',
  'List all storage buckets',
  {
    schemaName: z.string().describe('The schema name'),
  },
  async ({ schemaName }) => {
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/storage/buckets`);
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// List files
server.tool(
  'list_files',
  'List files in a bucket',
  {
    schemaName: z.string().describe('The schema name'),
    bucketName: z.string().describe('The bucket name'),
    prefix: z.string().optional().describe('Path prefix to filter files'),
  },
  async ({ schemaName, bucketName, prefix }) => {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    const result = await apiRequest(`/api/v1/schemas/${schemaName}/storage/buckets/${bucketName}/files${query}`);
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Druvia MCP Server started');
}

main().catch(console.error);
```

---

## Module 5: M10 Environment Management

### Task 17: Create environments database table

**Files:**
- Create: `migrations/009_create_project_environments.sql`

**Step 1: Create migration**

```sql
-- migrations/009_create_project_environments.sql
-- Project environments for dev/prod isolation

CREATE TABLE IF NOT EXISTS druvia_project_environments (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  env_name VARCHAR(20) NOT NULL,
  schema_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, env_name)
);

CREATE INDEX idx_project_environments_project ON druvia_project_environments(project_id);

-- Insert prod environment for existing projects
INSERT INTO druvia_project_environments (project_id, env_name, schema_name)
SELECT project_id, 'prod', schema_name
FROM druvia_projects
ON CONFLICT DO NOTHING;
```

---

### Task 18: Create environment service

**Files:**
- Create: `apps/api/src/modules/environment/environment.service.ts`

**Step 1: Create service**

```typescript
// apps/api/src/modules/environment/environment.service.ts
import { pool } from '../../db';

export interface ProjectEnvironment {
  id: number;
  projectId: string;
  envName: string;
  schemaName: string;
  createdAt: Date;
}

export function resolveSchemaName(baseSchema: string, env?: string): string {
  if (!env || env === 'prod') {
    return baseSchema;
  }
  return `${baseSchema}_${env}`;
}

export async function listEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const result = await pool.query(
    `SELECT id, project_id, env_name, schema_name, created_at
     FROM druvia_project_environments
     WHERE project_id = $1
     ORDER BY env_name`,
    [projectId]
  );

  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    envName: row.env_name,
    schemaName: row.schema_name,
    createdAt: row.created_at,
  }));
}

export async function createEnvironment(
  projectId: string,
  envName: string,
  cloneData: boolean = false
): Promise<ProjectEnvironment> {
  // Get base schema
  const projectResult = await pool.query(
    'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found');
  }

  const baseSchema = projectResult.rows[0].schema_name;
  const newSchema = resolveSchemaName(baseSchema, envName);

  // Clone schema structure
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${newSchema}"`);

  // Get all tables from base schema
  const tablesResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [baseSchema]
  );

  // Clone each table
  for (const row of tablesResult.rows) {
    const tableName = row.table_name;
    if (cloneData) {
      await pool.query(
        `CREATE TABLE "${newSchema}"."${tableName}" AS
         SELECT * FROM "${baseSchema}"."${tableName}"`
      );
    } else {
      await pool.query(
        `CREATE TABLE "${newSchema}"."${tableName}" (LIKE "${baseSchema}"."${tableName}" INCLUDING ALL)`
      );
    }
  }

  // Insert environment record
  const result = await pool.query(
    `INSERT INTO druvia_project_environments (project_id, env_name, schema_name)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, env_name, schema_name, created_at`,
    [projectId, envName, newSchema]
  );

  return {
    id: result.rows[0].id,
    projectId: result.rows[0].project_id,
    envName: result.rows[0].env_name,
    schemaName: result.rows[0].schema_name,
    createdAt: result.rows[0].created_at,
  };
}

export async function deleteEnvironment(projectId: string, envName: string): Promise<boolean> {
  if (envName === 'prod') {
    throw new Error('Cannot delete production environment');
  }

  // Get schema name
  const envResult = await pool.query(
    `SELECT schema_name FROM druvia_project_environments
     WHERE project_id = $1 AND env_name = $2`,
    [projectId, envName]
  );

  if (envResult.rows.length === 0) {
    return false;
  }

  const schemaName = envResult.rows[0].schema_name;

  // Drop schema
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

  // Delete record
  await pool.query(
    `DELETE FROM druvia_project_environments WHERE project_id = $1 AND env_name = $2`,
    [projectId, envName]
  );

  return true;
}
```

---

### Task 19: Create environment routes

**Files:**
- Create: `apps/api/src/modules/environment/environment.routes.ts`

**Step 1: Create routes**

```typescript
// apps/api/src/modules/environment/environment.routes.ts
import { FastifyInstance } from 'fastify';
import { listEnvironments, createEnvironment, deleteEnvironment } from './environment.service';

export async function environmentRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/environments
  fastify.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/environments',
    async (request, reply) => {
      const { projectId } = request.params;
      const envs = await listEnvironments(projectId);
      return reply.send({ success: true, data: envs });
    }
  );

  // POST /api/v1/projects/:projectId/environments
  fastify.post<{
    Params: { projectId: string };
    Body: { envName: string; cloneData?: boolean };
  }>(
    '/projects/:projectId/environments',
    async (request, reply) => {
      const { projectId } = request.params;
      const { envName, cloneData } = request.body;

      if (!envName || !['dev', 'staging'].includes(envName)) {
        return reply.status(400).send({ success: false, error: 'Invalid environment name' });
      }

      const env = await createEnvironment(projectId, envName, cloneData);
      return reply.status(201).send({ success: true, data: env });
    }
  );

  // DELETE /api/v1/projects/:projectId/environments/:envName
  fastify.delete<{ Params: { projectId: string; envName: string } }>(
    '/projects/:projectId/environments/:envName',
    async (request, reply) => {
      const { projectId, envName } = request.params;

      try {
        const deleted = await deleteEnvironment(projectId, envName);
        if (!deleted) {
          return reply.status(404).send({ success: false, error: 'Environment not found' });
        }
        return reply.send({ success: true });
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: err instanceof Error ? err.message : 'Delete failed',
        });
      }
    }
  );
}
```

**Step 2: Register routes**

Add to `apps/api/src/index.ts`:
```typescript
import { environmentRoutes } from './modules/environment/environment.routes';

app.register(environmentRoutes, { prefix: '/api/v1' });
```

---

### Task 20: Create environment management page

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/environments/page.tsx`

**Step 1: Create the page**

```typescript
// apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/environments/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { GitBranch, Plus, Trash2, CheckCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

interface Environment {
  id: number;
  envName: string;
  schemaName: string;
  createdAt: string;
}

export default function EnvironmentsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { toast } = useToast();

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [cloneData, setCloneData] = useState(false);
  const [deleteEnv, setDeleteEnv] = useState<string | null>(null);

  const loadEnvironments = async () => {
    try {
      const res = await api.get(`/api/v1/projects/${projectId}/environments`);
      if (res.data.success) {
        setEnvironments(res.data.data);
      }
    } catch {
      toast({ title: '加载失败', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEnvironments();
  }, [projectId]);

  const hasDevEnv = environments.some(e => e.envName === 'dev');

  const handleCreateDev = async () => {
    setCreating(true);
    try {
      await api.post(`/api/v1/projects/${projectId}/environments`, {
        envName: 'dev',
        cloneData,
      });
      loadEnvironments();
      toast({ title: '开发环境已创建' });
    } catch {
      toast({ title: '创建失败', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteEnv) return;
    try {
      await api.delete(`/api/v1/projects/${projectId}/environments/${deleteEnv}`);
      loadEnvironments();
      toast({ title: '环境已删除' });
    } catch {
      toast({ title: '删除失败', variant: 'destructive' });
    } finally {
      setDeleteEnv(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="h-6 w-6" />
            环境管理
          </h1>
          <p className="text-muted-foreground">管理项目的开发和生产环境</p>
        </div>

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">加载中...</div>
        ) : (
          <div className="space-y-4">
            {/* Production Environment */}
            <div className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full bg-green-500" />
                  <div>
                    <div className="font-medium">生产环境 (prod)</div>
                    <div className="text-sm text-muted-foreground">
                      {environments.find(e => e.envName === 'prod')?.schemaName || '默认 Schema'}
                    </div>
                  </div>
                </div>
                <CheckCircle className="h-5 w-5 text-green-500" />
              </div>
            </div>

            {/* Dev Environment */}
            {hasDevEnv ? (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-3 w-3 rounded-full bg-yellow-500" />
                    <div>
                      <div className="font-medium">开发环境 (dev)</div>
                      <div className="text-sm text-muted-foreground">
                        {environments.find(e => e.envName === 'dev')?.schemaName}
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteEnv('dev')}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border rounded-lg p-4 border-dashed">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">开发环境 (dev)</div>
                    <div className="text-sm text-muted-foreground">
                      创建独立的开发环境进行测试
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={cloneData} onCheckedChange={setCloneData} />
                      克隆数据
                    </label>
                    <Button onClick={handleCreateDev} disabled={creating}>
                      <Plus className="h-4 w-4 mr-2" />
                      {creating ? '创建中...' : '创建'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteEnv} onOpenChange={() => setDeleteEnv(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除开发环境</AlertDialogTitle>
              <AlertDialogDescription>
                删除后，开发环境的所有数据将被永久删除。此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
```

---

### Task 21: Add environment switcher to project layout

**Files:**
- Modify: `apps/admin/src/components/DashboardLayout.tsx`
- Modify: `apps/admin/src/store/index.ts`

**Step 1: Add environment state to store with URL sync**

Add to `apps/admin/src/store/index.ts`:
```typescript
// Add to AppState interface
currentEnv: 'prod' | 'dev';
setCurrentEnv: (env: 'prod' | 'dev') => void;

// Add to create function
currentEnv: 'prod',
setCurrentEnv: (env) => set({ currentEnv: env }),
```

**Step 2: Create useEnvSync hook for URL parameter sync**

Create `apps/admin/src/hooks/use-env-sync.ts`:
```typescript
'use client';

import { useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useAppStore } from '@/store';

export function useEnvSync() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { currentEnv, setCurrentEnv } = useAppStore();

  // Sync URL param to store on mount
  useEffect(() => {
    const envParam = searchParams.get('env');
    if (envParam === 'dev' || envParam === 'prod') {
      setCurrentEnv(envParam);
    }
  }, [searchParams, setCurrentEnv]);

  // Update URL when env changes
  const updateEnv = (env: 'prod' | 'dev') => {
    setCurrentEnv(env);
    const params = new URLSearchParams(searchParams.toString());
    if (env === 'prod') {
      params.delete('env');
    } else {
      params.set('env', env);
    }
    const query = params.toString();
    router.push(`${pathname}${query ? `?${query}` : ''}`);
  };

  return { currentEnv, updateEnv };
}
```

**Step 3: Add environment switcher component**

Add to DashboardLayout:
```typescript
import { useEnvSync } from '@/hooks/use-env-sync';

// In component
const { currentEnv, updateEnv } = useEnvSync();

<Select value={currentEnv} onValueChange={updateEnv}>
  <SelectTrigger className="w-24">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="prod">
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-green-500" />
        prod
      </span>
    </SelectItem>
    <SelectItem value="dev">
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-yellow-500" />
        dev
      </span>
    </SelectItem>
  </SelectContent>
</Select>
```

---

## Summary

| Module | Tasks | Key Files |
|--------|-------|-----------|
| M6 Data Generator | 4 tasks | DataGeneratorDialog.tsx, faker-mapping.ts |
| M15 Form Validation | 4 tasks | lib/schemas/index.ts, CreateTableDialog, EditTableDialog, CreateProjectDialog |
| M21 Single-Tenant | 5 tasks | tenant-config.ts, middleware.ts |
| M16 MCP Integration | 5 tasks | packages/mcp-server/, api-keys/ |
| M10 Environment | 5 tasks | environment.service.ts, environments/page.tsx, use-env-sync.ts |

Total: 23 tasks
