# Phase 2 实施计划：SQL 编辑器增强 + 数据库导入导出

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 增强 SQL 编辑体验，支持语法高亮和自动完成；新增 SQL 文本导入功能

**Architecture:** 集成 @uiw/react-codemirror 替换现有 textarea；扩展 API 支持 SQL 文件导入

**Tech Stack:** React 18+, @uiw/react-codemirror, @codemirror/lang-sql, TypeScript

---

## 外部依赖

| 包名 | 版本 | 许可证 | 用途 |
|------|------|--------|------|
| @uiw/react-codemirror | ^4.25.5 | MIT | CodeMirror 6 React 封装 |
| @codemirror/lang-sql | ^6.10.0 | MIT | SQL 语法高亮、自动完成 |
| sql-formatter | ^15.0.0 | MIT | SQL 格式化 |

---

## 现有代码分析

| 组件/模块 | 位置 | 现状 |
|----------|------|------|
| 数据库页面 | `apps/admin/src/app/t/.../database/page.tsx` | ✅ 基础 textarea，支持执行 |
| SQL 执行 API | `apps/api/src/modules/project/project.service.ts` | ✅ executeQuery + executeDdl |
| 数据导出 | `apps/api/src/modules/data/data.service.ts` | ✅ CSV/JSON 流式导出 |
| 数据导入 | - | ❌ 不存在 |

## 需要新增/修改

| 功能 | 说明 |
|------|------|
| CodeMirror SQL 编辑器组件 | 替换现有 textarea |
| Schema 元数据获取 API | 提供表名/字段名用于自动完成 |
| SQL 格式化功能 | 一键格式化 SQL |
| SQL 文件导入 API | 支持 SQL 文本文件导入执行 |
| 导入/导出 UI | 数据库页面新增 Tab |

---

## Task 1: 安装 CodeMirror 依赖

**Step 1: 安装包**

```bash
cd apps/admin && pnpm add @uiw/react-codemirror @codemirror/lang-sql sql-formatter
```

**Step 2: 验证安装**

```bash
pnpm list @uiw/react-codemirror @codemirror/lang-sql
```

Expected: 显示已安装版本

---

## Task 2: 创建 SqlEditor 组件

**Files:**
- Create: `apps/admin/src/components/SqlEditor.tsx`

**Step 1: 创建组件**

```tsx
// apps/admin/src/components/SqlEditor.tsx
'use client';

import { useMemo, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { keymap } from '@codemirror/view';
import { format } from 'sql-formatter';

export interface SqlEditorRef {
  getValue: () => string;
  setValue: (value: string) => void;
  formatSql: () => void;
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute?: () => void;
  schema?: Record<string, string[]>; // { tableName: ['col1', 'col2'] }
  readOnly?: boolean;
  height?: string;
  placeholder?: string;
}

export const SqlEditor = forwardRef<SqlEditorRef, SqlEditorProps>(
  function SqlEditor(
    {
      value,
      onChange,
      onExecute,
      schema,
      readOnly = false,
      height = '300px',
      placeholder = '输入 SQL 语句...',
    },
    ref
  ) {
    const editorRef = useRef<ReactCodeMirrorRef>(null);

    // 格式化 SQL
    const formatSql = useCallback(() => {
      try {
        const formatted = format(value, {
          language: 'postgresql',
          tabWidth: 2,
          keywordCase: 'upper',
        });
        onChange(formatted);
      } catch (e) {
        // 格式化失败时保持原样
        console.warn('SQL format failed:', e);
      }
    }, [value, onChange]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      getValue: () => value,
      setValue: (newValue: string) => onChange(newValue),
      formatSql,
    }));

    // SQL 语言配置（含自动完成）
    const sqlExtension = useMemo(() => {
      return sql({
        dialect: PostgreSQL,
        schema: schema || {},
        upperCaseKeywords: true,
      });
    }, [schema]);

    // 快捷键配置
    const keymapExtension = useMemo(() => {
      return keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onExecute?.();
            return true;
          },
        },
        {
          key: 'Mod-Shift-f',
          run: () => {
            formatSql();
            return true;
          },
        },
      ]);
    }, [onExecute, formatSql]);

    return (
      <CodeMirror
        ref={editorRef}
        value={value}
        onChange={onChange}
        extensions={[sqlExtension, keymapExtension]}
        readOnly={readOnly}
        placeholder={placeholder}
        height={height}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          history: true,
          foldGutter: true,
          drawSelection: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          syntaxHighlighting: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          rectangularSelection: true,
          crosshairCursor: true,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          defaultKeymap: true,
          searchKeymap: true,
          historyKeymap: true,
          foldKeymap: true,
          completionKeymap: true,
          lintKeymap: true,
        }}
        className="border rounded-md overflow-hidden"
      />
    );
  }
);
```

**Step 2: 验证编译**

```bash
cd apps/admin && pnpm tsc --noEmit
```

Expected: 无错误

---

## Task 3: 创建 Schema 元数据 API

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts`
- Modify: `apps/api/src/modules/table/table.routes.ts`

**Step 1: 添加 Service 方法**

在 `table.service.ts` 中添加：

```typescript
/**
 * 获取 Schema 元数据（用于 SQL 编辑器自动完成）
 */
export async function getSchemaMetadata(
  schemaName: string
): Promise<Record<string, string[]>> {
  validateIdentifier(schemaName);

  const client = await pool.connect();
  try {
    const result = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT
        c.table_name,
        c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = $1
      ORDER BY c.table_name, c.ordinal_position`,
      [schemaName]
    );

    // 转换为 { tableName: ['col1', 'col2'] } 格式
    const schema: Record<string, string[]> = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) {
        schema[row.table_name] = [];
      }
      schema[row.table_name].push(row.column_name);
    }

    return schema;
  } finally {
    client.release();
  }
}
```

**Step 2: 添加路由**

在 `table.routes.ts` 中添加：

```typescript
app.get('/schemas/:schemaName/metadata', controller.getSchemaMetadata);
```

**Step 3: 添加 Controller**

```typescript
async getSchemaMetadata(
  request: FastifyRequest<{ Params: { schemaName: string } }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;
  const metadata = await tableService.getSchemaMetadata(schemaName);
  return reply.send({ success: true, data: metadata });
}
```

**Step 4: 前端 API 调用**

在 `apps/admin/src/lib/api.ts` 中添加：

```typescript
async getSchemaMetadata(schemaName: string): Promise<ApiResponse<Record<string, string[]>>> {
  return this.request('GET', `/api/v1/schemas/${schemaName}/metadata`);
}
```

---

## Task 4: 更新数据库页面使用 SqlEditor

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/database/page.tsx`

**Step 1: 导入 SqlEditor**

```tsx
import { SqlEditor, SqlEditorRef } from '@/components/SqlEditor';
```

**Step 2: 添加 Schema 元数据获取**

```tsx
const [schemaMetadata, setSchemaMetadata] = useState<Record<string, string[]>>({});

useEffect(() => {
  if (currentProject?.schemaName) {
    api.getSchemaMetadata(currentProject.schemaName)
      .then(res => {
        if (res.success && res.data) {
          setSchemaMetadata(res.data);
        }
      })
      .catch(console.error);
  }
}, [currentProject?.schemaName]);
```

**Step 3: 替换 textarea 为 SqlEditor**

```tsx
<SqlEditor
  value={sql}
  onChange={setSql}
  onExecute={handleExecute}
  schema={schemaMetadata}
  height="300px"
  placeholder="输入 SQL 语句... (Cmd/Ctrl + Enter 执行, Cmd/Ctrl + Shift + F 格式化)"
/>
```

**Step 4: 添加格式化按钮**

```tsx
<Button
  variant="outline"
  size="sm"
  onClick={() => editorRef.current?.formatSql()}
>
  <Code className="h-4 w-4 mr-2" />
  格式化
</Button>
```

---

## Task 5: 创建 SQL 导入导出 API

**Files:**
- Modify: `apps/api/src/modules/project/project.service.ts`
- Modify: `apps/api/src/modules/project/project.routes.ts`

**Step 1: 添加导出 SQL 方法**

在 `project.service.ts` 中添加：

```typescript
export type ExportType = 'full' | 'schema-only' | 'data-only';

/**
 * 导出 Schema 为 SQL 文本
 */
export async function exportSchemaSql(
  schemaName: string,
  exportType: ExportType = 'full'
): Promise<string> {
  validateIdentifier(schemaName);

  const client = await pool.connect();
  try {
    const lines: string[] = [];
    lines.push(`-- Druvia SQL Export`);
    lines.push(`-- Schema: ${schemaName}`);
    lines.push(`-- Export Type: ${exportType}`);
    lines.push(`-- Date: ${new Date().toISOString()}`);
    lines.push('');

    // 获取所有表
    const tablesResult = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schemaName]
    );

    for (const table of tablesResult.rows) {
      const tableName = table.table_name;

      // Schema 部分
      if (exportType !== 'data-only') {
        lines.push(`-- Table: ${tableName}`);

        // 获取表结构
        const columnsResult = await client.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          character_maximum_length: number | null;
        }>(
          `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schemaName, tableName]
        );

        // 获取主键
        const pkResult = await client.query<{ column_name: string }>(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = $1
             AND tc.table_name = $2`,
          [schemaName, tableName]
        );
        const pkColumns = new Set(pkResult.rows.map(r => r.column_name));

        // 生成 CREATE TABLE
        lines.push(`CREATE TABLE IF NOT EXISTS "${tableName}" (`);
        const columnDefs: string[] = [];
        for (const col of columnsResult.rows) {
          let typeDef = col.data_type;
          if (col.character_maximum_length) {
            typeDef = `${col.data_type}(${col.character_maximum_length})`;
          }

          let colDef = `  "${col.column_name}" ${typeDef}`;
          if (col.is_nullable === 'NO') colDef += ' NOT NULL';
          if (col.column_default) colDef += ` DEFAULT ${col.column_default}`;
          if (pkColumns.has(col.column_name)) colDef += ' PRIMARY KEY';

          columnDefs.push(colDef);
        }
        lines.push(columnDefs.join(',\n'));
        lines.push(');');
        lines.push('');
      }

      // 数据部分
      if (exportType !== 'schema-only') {
        const dataResult = await client.query(
          `SELECT * FROM "${schemaName}"."${tableName}"`
        );

        if (dataResult.rows.length > 0) {
          lines.push(`-- Data for table: ${tableName}`);
          const columns = dataResult.fields.map(f => `"${f.name}"`).join(', ');

          for (const row of dataResult.rows) {
            const values = dataResult.fields.map(f => {
              const val = row[f.name];
              if (val === null) return 'NULL';
              if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
              if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
              if (val instanceof Date) return `'${val.toISOString()}'`;
              if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
              return String(val);
            }).join(', ');

            lines.push(`INSERT INTO "${tableName}" (${columns}) VALUES (${values});`);
          }
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  } finally {
    client.release();
  }
}
```

**Step 2: 添加导入 SQL 方法**

```typescript
/**
 * 导入 SQL 文件（执行 SQL 语句）
 */
export async function importSql(
  schemaName: string,
  sqlContent: string
): Promise<{ success: boolean; statementsExecuted: number; errors: string[] }> {
  validateIdentifier(schemaName);

  const client = await pool.connect();
  const errors: string[] = [];
  let statementsExecuted = 0;

  try {
    await client.query('BEGIN');
    await client.query(`SET search_path TO "${schemaName}"`);

    // 简单分割 SQL 语句（按分号）
    // 注意：这是简化实现，不处理复杂情况如字符串中的分号
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        // 跳过注释和空语句
        if (stmt.startsWith('--') || stmt.length === 0) continue;

        // 安全检查：使用与 executeDdl 相同的检查
        const upperStmt = stmt.toUpperCase();
        const dangerousPatterns = [
          /DROP\s+(SCHEMA|DATABASE)/i,
          /CREATE\s+(SCHEMA|DATABASE)/i,
          /ALTER\s+(SCHEMA|DATABASE)/i,
          /DROP\s+(ROLE|USER)/i,
          /CREATE\s+(ROLE|USER)/i,
          /GRANT\s+/i,
          /REVOKE\s+/i,
        ];

        const isDangerous = dangerousPatterns.some(p => p.test(stmt));
        if (isDangerous) {
          errors.push(`Skipped dangerous statement: ${stmt.substring(0, 50)}...`);
          continue;
        }

        await client.query(stmt);
        statementsExecuted++;
      } catch (err) {
        errors.push(`Error in statement: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await client.query('COMMIT');
    return { success: errors.length === 0, statementsExecuted, errors };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.query('RESET search_path');
    client.release();
  }
}
```

**Step 3: 添加路由**

```typescript
// 导出 SQL
app.get('/projects/:projectId/export-sql', controller.exportSql);

// 导入 SQL
app.post('/projects/:projectId/import-sql', controller.importSql);
```

**Step 4: 添加 Controller**

```typescript
async exportSql(
  request: FastifyRequest<{
    Params: { projectId: string };
    Querystring: { type?: 'full' | 'schema-only' | 'data-only' };
  }>,
  reply: FastifyReply
) {
  const { projectId } = request.params;
  const exportType = request.query.type || 'full';

  // 获取项目的 schemaName
  const project = await projectService.findById(projectId);
  if (!project) {
    return reply.status(404).send({ success: false, error: { message: 'Project not found' } });
  }

  const sqlContent = await projectService.exportSchemaSql(project.schemaName, exportType);

  reply.header('Content-Type', 'application/sql');
  reply.header('Content-Disposition', `attachment; filename="${project.schemaName}_${exportType}.sql"`);
  return reply.send(sqlContent);
}

async importSql(
  request: FastifyRequest<{
    Params: { projectId: string };
    Body: { sql: string };
  }>,
  reply: FastifyReply
) {
  const { projectId } = request.params;
  const { sql } = request.body;

  if (!sql || typeof sql !== 'string') {
    return reply.status(400).send({ success: false, error: { message: 'SQL content required' } });
  }

  // 获取项目的 schemaName
  const project = await projectService.findById(projectId);
  if (!project) {
    return reply.status(404).send({ success: false, error: { message: 'Project not found' } });
  }

  const result = await projectService.importSql(project.schemaName, sql);
  return reply.send({ success: result.success, data: result });
}
```

---

## Task 6: 前端导入导出 UI

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/database/page.tsx`

**Step 1: 添加导入导出状态**

```tsx
const [showImportExport, setShowImportExport] = useState(false);
const [exportType, setExportType] = useState<'full' | 'schema-only' | 'data-only'>('full');
const [importing, setImporting] = useState(false);
const [exporting, setExporting] = useState(false);
```

**Step 2: 添加导出处理函数**

```tsx
const handleExport = async () => {
  if (!currentProject) return;
  setExporting(true);
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${projectId}/export-sql?type=${exportType}`,
      {
        headers: { Authorization: `Bearer ${getToken()}` },
      }
    );
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentProject.schemaName}_${exportType}.sql`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: '导出成功' });
  } catch (error) {
    toast({ title: '导出失败', variant: 'destructive' });
  } finally {
    setExporting(false);
  }
};
```

**Step 3: 添加导入处理函数**

```tsx
const handleImport = async (file: File) => {
  if (!currentProject) return;
  setImporting(true);
  try {
    const text = await file.text();
    const response = await api.importSql(projectId, text);
    if (response.success) {
      toast({
        title: '导入完成',
        description: `执行了 ${response.data.statementsExecuted} 条语句`,
      });
      if (response.data.errors.length > 0) {
        console.warn('Import errors:', response.data.errors);
      }
    }
  } catch (error) {
    toast({ title: '导入失败', variant: 'destructive' });
  } finally {
    setImporting(false);
  }
};
```

**Step 4: 添加导入导出 UI**

在工具栏添加按钮和对话框：

```tsx
<Dialog open={showImportExport} onOpenChange={setShowImportExport}>
  <DialogTrigger asChild>
    <Button variant="outline" size="sm">
      <FileUp className="h-4 w-4 mr-2" />
      导入/导出
    </Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>SQL 导入/导出</DialogTitle>
    </DialogHeader>

    <Tabs defaultValue="export">
      <TabsList>
        <TabsTrigger value="export">导出</TabsTrigger>
        <TabsTrigger value="import">导入</TabsTrigger>
      </TabsList>

      <TabsContent value="export" className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">导出类型</label>
          <RadioGroup value={exportType} onValueChange={setExportType}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="full" id="full" />
              <Label htmlFor="full">完整 (结构 + 数据)</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="schema-only" id="schema-only" />
              <Label htmlFor="schema-only">仅结构</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="data-only" id="data-only" />
              <Label htmlFor="data-only">仅数据</Label>
            </div>
          </RadioGroup>
        </div>
        <Button onClick={handleExport} disabled={exporting}>
          {exporting ? '导出中...' : '导出 SQL'}
        </Button>
      </TabsContent>

      <TabsContent value="import" className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">选择 SQL 文件</label>
          <Input
            type="file"
            accept=".sql"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
            }}
            disabled={importing}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          支持导入 .sql 文件，将在当前 Schema 中执行
        </p>
      </TabsContent>
    </Tabs>
  </DialogContent>
</Dialog>
```

---

## Task 7: 添加前端 API 方法

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

```typescript
async exportSql(
  projectId: string,
  type: 'full' | 'schema-only' | 'data-only' = 'full'
): Promise<Blob> {
  const response = await fetch(
    `${this.baseUrl}/api/v1/projects/${projectId}/export-sql?type=${type}`,
    {
      headers: this.getHeaders(),
    }
  );
  if (!response.ok) {
    throw new Error('Export failed');
  }
  return response.blob();
}

async importSql(
  projectId: string,
  sql: string
): Promise<ApiResponse<{ statementsExecuted: number; errors: string[] }>> {
  return this.request('POST', `/api/v1/projects/${projectId}/import-sql`, { sql });
}
```

---

## Task 8: 端到端测试

**Step 1: 启动开发服务器**

```bash
pnpm dev
```

**Step 2: 测试 SQL 编辑器增强**

1. 登录管理后台
2. 进入租户 > 项目 > 数据库
3. 验证 SQL 编辑器有语法高亮
4. 输入表名，验证自动完成弹出表名和字段名
5. 按 Cmd/Ctrl + Shift + F，验证 SQL 格式化
6. 输入 SQL，按 Cmd/Ctrl + Enter，验证执行

**Step 3: 测试导入导出**

1. 点击「导入/导出」按钮
2. 选择「完整」导出类型，点击导出
3. 验证下载 .sql 文件
4. 打开 .sql 文件，验证内容正确
5. 选择「导入」Tab，上传刚才导出的文件
6. 验证导入成功提示

---

## 验收标准

### M3 SQL 编辑器增强
- [ ] SQL 语法高亮 (PostgreSQL)
- [ ] 表名/字段名自动完成
- [ ] Cmd/Ctrl + Enter 执行
- [ ] Cmd/Ctrl + Shift + F 格式化
- [ ] 格式化按钮可用

### M4 数据库导入导出
- [ ] 可导出完整 SQL (结构 + 数据)
- [ ] 可导出仅结构
- [ ] 可导出仅数据
- [ ] 可导入 .sql 文件
- [ ] 导入有安全检查（阻止危险语句）
- [ ] 导入失败有错误提示

---

## 安全考虑

1. **导入安全检查**：阻止 DROP SCHEMA/DATABASE、CREATE ROLE 等危险操作
2. **大小限制**：前端限制文件大小（建议 10MB）
3. **超时控制**：导入操作设置合理超时
4. **Schema 隔离**：只能操作当前项目的 Schema

---

**创建日期**: 2026-03-02
**状态**: 待实施
