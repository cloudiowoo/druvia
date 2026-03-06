# Phase 5 P1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement CSV import, API testing tools, and API documentation generation for Druvia.

**Architecture:** Three modules - M4-CSV uses papaparse for parsing with custom mapping UI; M5 combines GraphiQL for GraphQL and Scalar for REST testing; M9 auto-generates OpenAPI from table schemas and uses Scalar for rendering.

**Tech Stack:** papaparse, @graphiql/react, @scalar/api-client-react, @scalar/api-reference-react

---

> **Review Notes (2026-03-06):**
> - Added `checkProjectAccess` preHandler to import routes for security (from `apps/api/src/lib/access.ts`)
> - Fixed pg-format usage - now passes values as separate array parameter
> - Added table existence verification before import
> - Fixed project query to use `project_id` (VARCHAR) instead of `id` (SERIAL)
> - Updated route registration to be module-relative instead of app.ts
> - Added TODO for fetching Hasura credentials from project settings
> - Fixed database import path: `../../db` (not `../../infra/database`)
> - Fixed ColumnInfo interface: SQL returns `column_name` not `name`
> - Fixed duplicate OpenAPI route: merged JSON/YAML into single handler with `?format=` query

---

## Phase Overview

| Order | Module | Description |
|-------|--------|-------------|
| 1 | M4-CSV | CSV import to existing tables |
| 2 | M9 | OpenAPI generation + documentation |
| 3 | M5 | API testing (GraphQL + REST) |

---

## Module 1: M4-CSV Import

### Task 1: Install papaparse dependency

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: Install papaparse**

Run:
```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm add papaparse @types/papaparse
```

**Step 2: Verify installation**

Run:
```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm list papaparse
```
Expected: `papaparse 5.x.x`

---

### Task 2: Create CSV import API endpoint

**Files:**
- Create: `apps/api/src/modules/table/import.routes.ts`
- Modify: `apps/api/src/modules/table/table.routes.ts` (register routes)

**Step 1: Create import route handler with proper security**

```typescript
// apps/api/src/modules/table/import.routes.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db';
import format from 'pg-format';
import { checkProjectAccess } from '../../lib/access';

interface ImportRow {
  [key: string]: unknown;
}

interface ImportOptions {
  onError: 'skip' | 'abort';
  batchSize: number;
}

interface ImportRequest {
  rows: ImportRow[];
  options: ImportOptions;
}

interface ImportError {
  row: number;
  error: string;
}

interface ImportParams {
  schemaName: string;
  tableName: string;
}

export async function importRoutes(fastify: FastifyInstance) {
  // POST /api/v1/schemas/:schemaName/tables/:tableName/import
  fastify.post<{
    Params: ImportParams;
    Body: ImportRequest;
    Reply: FastifyReply;
  }>(
    '/:schemaName/tables/:tableName/import',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const params = request.params as ImportParams;
        // Verify user has access to this project schema
        // TODO: Adapt checkProjectAccess to accept schemaName lookup
        await checkProjectAccess(request, reply, params.schemaName);
      },
    },
    async (request, reply) => {
      const { schemaName, tableName } = request.params as ImportParams;
      const { rows, options } = request.body;
      const { onError = 'skip', batchSize = 100 } = options || {};

      if (!rows || rows.length === 0) {
        return reply.status(400).send({ error: 'No rows to import' });
      }

      const errors: ImportError[] = [];
      let imported = 0;
      let skipped = 0;

      // Verify table exists in schema
      const tableCheck = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, tableName]
      );

      if (tableCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Table not found' });
      }

      // Get column names from first row
      const columns = Object.keys(rows[0]);

      // Process in batches
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const rowIndex = i + j + 1;
          const values = columns.map(col => row[col]);

          try {
            // Use pg-format for identifier escaping, $N for value params
            const columnList = columns.map(c => format('%I', c)).join(', ');
            const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            const sql = format(
              'INSERT INTO %I.%I (%s) VALUES (%s)',
              schemaName,
              tableName,
              columnList,
              placeholders
            );
            await pool.query(sql, values);
            imported++;
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            errors.push({ row: rowIndex, error: errorMsg });

            if (onError === 'abort') {
              return reply.status(400).send({
                success: false,
                imported,
                skipped,
                errors,
                abortedAt: rowIndex
              });
            }
            skipped++;
          }
        }
      }

      return reply.send({
        success: true,
        imported,
        skipped,
        errors: errors.slice(0, 100)
      });
    }
  );
}
```

**Step 2: Register import routes**

Add to `apps/api/src/modules/table/table.routes.ts`:

```typescript
// Add import at top
import { importRoutes } from './import.routes';

// In the route registration, add:
fastify.register(importRoutes, { prefix: '/schemas' });
```

**Step 3: Test API manually**

Run dev server and test with curl:
```bash
curl -X POST http://localhost:3001/api/v1/schemas/tenant_xxx/tables/posts/import \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"title":"Test"}],"options":{"onError":"skip"}}'
```

---

### Task 3: Create CsvImportDialog component

**Files:**
- Create: `apps/admin/src/components/data/CsvImportDialog.tsx`

**Step 1: Create the dialog component**

```typescript
// apps/admin/src/components/data/CsvImportDialog.tsx
'use client';

import { useState, useCallback } from 'react';
import Papa from 'papaparse';
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
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface Column {
  name: string;
  type: string;
}

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  tableName: string;
  columns: Column[];
  onSuccess?: () => void;
}

type ImportStatus = 'idle' | 'parsing' | 'mapping' | 'importing' | 'done' | 'error';

interface ColumnMapping {
  csvColumn: string;
  tableColumn: string | null;
}

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

export function CsvImportDialog({
  open,
  onOpenChange,
  schemaName,
  tableName,
  columns,
  onSuccess,
}: CsvImportDialogProps) {
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [onError, setOnError] = useState<'skip' | 'abort'>('skip');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (selectedFile.size > 10 * 1024 * 1024) {
      setError('文件大小不能超过 10MB');
      return;
    }

    setFile(selectedFile);
    setStatus('parsing');
    setError(null);

    Papa.parse(selectedFile, {
      complete: (results) => {
        const data = results.data as string[][];
        if (data.length === 0) {
          setError('CSV 文件为空');
          setStatus('idle');
          return;
        }

        const headers = data[0];
        const rows = data.slice(1, 11); // Preview first 10 rows

        setCsvHeaders(headers);
        setCsvData(rows);

        // Auto-map columns
        const autoMappings = headers.map((csvCol) => {
          const match = columns.find(
            (tableCol) => tableCol.name.toLowerCase() === csvCol.toLowerCase()
          );
          return {
            csvColumn: csvCol,
            tableColumn: match?.name || null,
          };
        });

        setMappings(autoMappings);
        setStatus('mapping');
      },
      error: (err) => {
        setError(`解析失败: ${err.message}`);
        setStatus('idle');
      },
    });
  }, [columns]);

  const handleImport = async () => {
    if (!file) return;

    setStatus('importing');
    setError(null);

    Papa.parse(file, {
      complete: async (results) => {
        const data = results.data as string[][];
        const dataRows = data.slice(1).filter(row => row.some(cell => cell));

        // Transform rows based on mappings
        const rows = dataRows.map((row) => {
          const obj: Record<string, unknown> = {};
          mappings.forEach((mapping, idx) => {
            if (mapping.tableColumn) {
              obj[mapping.tableColumn] = row[idx] || null;
            }
          });
          return obj;
        });

        try {
          const response = await api.post(
            `/api/v1/schemas/${schemaName}/tables/${tableName}/import`,
            { rows, options: { onError, batchSize: 100 } }
          );

          setResult(response.data);
          setStatus('done');
          onSuccess?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : '导入失败');
          setStatus('error');
        }
      },
    });
  };

  const updateMapping = (csvColumn: string, tableColumn: string | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.csvColumn === csvColumn ? { ...m, tableColumn } : m
      )
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入 CSV 到 {tableName}</DialogTitle>
        </DialogHeader>

        {status === 'idle' && (
          <div className="space-y-4">
            <Label htmlFor="csv-file">选择 CSV 文件</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
            />
            {error && (
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {status === 'mapping' && (
          <div className="space-y-4">
            <div>
              <h3 className="font-medium mb-2">预览数据（前 10 行）</h3>
              <div className="border rounded overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {csvHeaders.map((header, idx) => (
                        <th key={idx} className="px-3 py-2 text-left">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvData.map((row, rowIdx) => (
                      <tr key={rowIdx} className="border-t">
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-3 py-2">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-2">列映射</h3>
              <div className="space-y-2">
                {mappings.map((mapping, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    <div className="flex-1">
                      <Label className="text-sm text-gray-600">
                        CSV: {mapping.csvColumn}
                      </Label>
                    </div>
                    <div className="flex-1">
                      <Select
                        value={mapping.tableColumn || '__skip__'}
                        onValueChange={(value) =>
                          updateMapping(
                            mapping.csvColumn,
                            value === '__skip__' ? null : value
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__skip__">（跳过）</SelectItem>
                          {columns.map((col) => (
                            <SelectItem key={col.name} value={col.name}>
                              {col.name} ({col.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label>错误处理</Label>
              <Select value={onError} onValueChange={(v) => setOnError(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">跳过错误行</SelectItem>
                  <SelectItem value="abort">遇到错误中断</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {status === 'importing' && (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p>正在导入...</p>
            </div>
          </div>
        )}

        {status === 'done' && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">导入完成</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-gray-600">成功</div>
                <div className="text-2xl font-bold">{result.imported}</div>
              </div>
              <div>
                <div className="text-gray-600">跳过</div>
                <div className="text-2xl font-bold">{result.skipped}</div>
              </div>
              <div>
                <div className="text-gray-600">错误</div>
                <div className="text-2xl font-bold">{result.errors.length}</div>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto border rounded p-2 text-sm">
                {result.errors.map((err, idx) => (
                  <div key={idx} className="text-red-600">
                    行 {err.row}: {err.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          {status === 'mapping' && (
            <>
              <Button variant="outline" onClick={() => setStatus('idle')}>
                重新选择
              </Button>
              <Button onClick={handleImport}>开始导入</Button>
            </>
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

### Task 4: Add import button to data page

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/data/page.tsx`

**Step 1: Add import button to toolbar**

Add the import button next to the "Add Row" button in the data page toolbar:

```tsx
import { CsvImportDialog } from '@/components/data/CsvImportDialog';

// In the component:
const [importOpen, setImportOpen] = useState(false);

// In the toolbar:
<Button variant="outline" onClick={() => setImportOpen(true)}>
  <Upload className="h-4 w-4 mr-2" />
  导入 CSV
</Button>

<CsvImportDialog
  open={importOpen}
  onOpenChange={setImportOpen}
  schemaName={schemaName}
  tableName={tableName}
  columns={columns}
  onSuccess={() => refetch()}
/>
```

---

### Task 5: Integration testing

**Step 1: Test CSV import flow**

Run:
```bash
# Start dev server
pnpm dev

# In Playwright or manually:
# 1. Navigate to table data page
# 2. Click "导入 CSV" button
# 3. Upload a CSV file
# 4. Verify column mapping preview
# 5. Click "开始导入"
# 6. Verify success message
```

---

## Module 2: M9 API Documentation

### Task 1: Install Scalar dependencies

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: Install dependencies**

Run:
```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm add @scalar/api-reference-react
```

**Step 2: Verify installation**

Run:
```bash
pnpm list @scalar/api-reference-react
```

---

### Task 2: Create OpenAPI generation service

**Files:**
- Create: `apps/api/src/modules/openapi/openapi.service.ts`
- Create: `apps/api/src/modules/openapi/schema-to-openapi.ts`

**Step 1: Create schema-to-openapi converter**

```typescript
// apps/api/src/modules/openapi/schema-to-openapi.ts

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

const TYPE_MAPPING: Record<string, { type: string; format?: string }> = {
  uuid: { type: 'string', format: 'uuid' },
  text: { type: 'string' },
  varchar: { type: 'string' },
  'character varying': { type: 'string' },
  char: { type: 'string' },
  integer: { type: 'integer' },
  int4: { type: 'integer' },
  bigint: { type: 'integer', format: 'int64' },
  int8: { type: 'integer', format: 'int64' },
  numeric: { type: 'number' },
  decimal: { type: 'number' },
  real: { type: 'number' },
  'double precision': { type: 'number' },
  boolean: { type: 'boolean' },
  bool: { type: 'boolean' },
  'timestamp without time zone': { type: 'string', format: 'date-time' },
  'timestamp with time zone': { type: 'string', format: 'date-time' },
  timestamp: { type: 'string', format: 'date-time' },
  timestamptz: { type: 'string', format: 'date-time' },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'time' },
  jsonb: { type: 'object' },
  json: { type: 'object' },
};

export function pgTypeToOpenApi(pgType: string): { type: string; format?: string } {
  const normalized = pgType.toLowerCase();
  return TYPE_MAPPING[normalized] || { type: 'string' };
}

export function generateOpenApiSchema(columns: ColumnInfo[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const col of columns) {
    const schema = pgTypeToOpenApi(col.data_type);
    properties[col.column_name] = schema;
    if (col.is_nullable === 'NO') {
      required.push(col.column_name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}
```

**Step 2: Create OpenAPI service**

```typescript
// apps/api/src/modules/openapi/openapi.service.ts
import { pool } from '../../db';
import { generateOpenApiSchema } from './schema-to-openapi';

interface TableInfo {
  table_name: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

export async function generateProjectOpenApi(
  projectId: string,
  baseUrl: string
): Promise<object> {
  // Get schema name from project - note: id is SERIAL, project_id is VARCHAR
  const projectResult = await pool.query(
    'SELECT schema_name FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found');
  }

  const schemaName = projectResult.rows[0].schema_name;

  // Get all tables
  const tablesResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schemaName]
  );

  const tables = tablesResult.rows as TableInfo[];
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const table of tables) {
    // Get columns for each table
    const columnsResult = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, table.table_name]
    );

    const columns = columnsResult.rows as ColumnInfo[];
    const tableName = table.table_name;
    const SchemaName = tableName.charAt(0).toUpperCase() + tableName.slice(1);

    // Generate schema
    const schema = generateOpenApiSchema(columns);
    schemas[SchemaName] = schema;
    schemas[`${SchemaName}Input`] = { ...schema, required: undefined };

    // Generate paths
    const basePath = `/api/v1/schemas/${schemaName}/tables/${tableName}`;

    paths[`${basePath}/rows`] = {
      get: {
        summary: `List ${tableName} rows`,
        tags: [tableName],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'orderBy', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'List of rows',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rows: { type: 'array', items: { $ref: `#/components/schemas/${SchemaName}` } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: `Create ${tableName} row`,
        tags: [tableName],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${SchemaName}Input` },
            },
          },
        },
        responses: {
          '201': { description: 'Created' },
        },
      },
    };

    paths[`${basePath}/rows/{id}`] = {
      get: {
        summary: `Get ${tableName} row by ID`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${SchemaName}` },
              },
            },
          },
        },
      },
      patch: {
        summary: `Update ${tableName} row`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${SchemaName}Input` },
            },
          },
        },
        responses: {
          '200': { description: 'Updated' },
        },
      },
      delete: {
        summary: `Delete ${tableName} row`,
        tags: [tableName],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Deleted' },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Druvia API',
      version: '1.0.0',
    },
    servers: [{ url: baseUrl }],
    paths,
    components: { schemas },
  };
}
```

---

### Task 3: Create OpenAPI routes

**Files:**
- Create: `apps/api/src/modules/openapi/openapi.routes.ts`

**Step 1: Create routes**

```typescript
// apps/api/src/modules/openapi/openapi.routes.ts
import { FastifyInstance } from 'fastify';
import { generateProjectOpenApi } from './openapi.service';

export async function openapiRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/openapi
  // Optional query: ?format=yaml
  fastify.get<{
    Params: { projectId: string };
    Querystring: { format?: string };
  }>(
    '/projects/:projectId/openapi',
    async (request, reply) => {
      const { projectId } = request.params;
      const { format } = request.query;
      const baseUrl = `${request.protocol}://${request.hostname}`;

      const openapi = await generateProjectOpenApi(projectId, baseUrl);

      if (format === 'yaml') {
        // TODO: Add js-yaml dependency for proper YAML conversion
        // For now, return JSON with yaml content-type note
        reply.header('Content-Type', 'application/x-yaml');
        return reply.send(JSON.stringify(openapi, null, 2));
      }

      return reply.send(openapi);
    }
  );
}
```

**Step 2: Register routes**

Register in `apps/api/src/index.ts` following the existing pattern:

```typescript
import { openapiRoutes } from './modules/openapi/openapi.routes';

// Register with API prefix
app.register(openapiRoutes, { prefix: '/api/v1' });
```

> **Note**: Check existing route registration in `apps/api/src/index.ts` for the exact pattern used.

**Step 3: Test the endpoint**

```bash
curl http://localhost:3001/api/v1/projects/<project-id>/openapi
```

---

### Task 4: Create API documentation component

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/ApiDocumentation.tsx`

**Step 1: Create the documentation component**

```tsx
// apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/ApiDocumentation.tsx
'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

interface ApiDocumentationProps {
  projectId: string;
}

export function ApiDocumentation({ projectId }: ApiDocumentationProps) {
  return (
    <div className="h-full">
      <ApiReferenceReact
        configuration={{
          spec: {
            url: `/api/v1/projects/${projectId}/openapi`,
          },
          theme: 'default',
        }}
      />
    </div>
  );
}
```

---

## Module 3: M5 API Testing Tools

### Task 1: Install GraphiQL dependencies

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: Install dependencies**

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/apps/admin && pnpm add @graphiql/react @graphiql/toolkit graphql
```

---

### Task 2: Create GraphQL Playground component

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLPlayground.tsx`

**Step 1: Create the component**

```tsx
// apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/GraphQLPlayground.tsx
'use client';

import { GraphiQL } from '@graphiql/react';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import '@graphiql/react/dist/style.css';

interface GraphQLPlaygroundProps {
  hasuraUrl: string;
  adminSecret: string;
}

export function GraphQLPlayground({ hasuraUrl, adminSecret }: GraphQLPlaygroundProps) {
  const fetcher = createGraphiQLFetcher({
    url: `${hasuraUrl}/v1/graphql`,
    headers: {
      'x-hasura-admin-secret': adminSecret,
    },
  });

  return (
    <div className="h-full">
      <GraphiQL fetcher={fetcher} />
    </div>
  );
}
```

---

### Task 3: Create REST Client component

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/RestClient.tsx`

**Step 1: Create the component**

```tsx
// apps/admin/src/app/t/[tenantId]/p/[projectId]/api/components/RestClient.tsx
'use client';

import { ApiClientReact } from '@scalar/api-client-react';
import '@scalar/api-client-react/style.css';

interface RestClientProps {
  openApiUrl?: string;
}

export function RestClient({ openApiUrl }: RestClientProps) {
  return (
    <div className="h-full">
      <ApiClientReact
        configuration={{
          spec: openApiUrl ? { url: openApiUrl } : undefined,
        }}
      />
    </div>
  );
}
```

---

### Task 4: Create API page with tabs

**Files:**
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/api/page.tsx`

**Step 1: Create the page**

```tsx
// apps/admin/src/app/t/[tenantId]/p/[projectId]/api/page.tsx
'use client';

import { useParams } from 'next/navigation';
import { GraphQLPlayground } from './components/GraphQLPlayground';
import { RestClient } from './components/RestClient';
import { ApiDocumentation } from './components/ApiDocumentation';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export default function ApiPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  // TODO: Get Hasura credentials from project settings API
  // Real implementation should fetch from: GET /api/v1/projects/:id/settings
  const hasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL || 'http://localhost:8080';
  const adminSecret = process.env.HASURA_ADMIN_SECRET || 'druvia-secret';

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-2xl font-bold">API 测试</h1>
        <p className="text-gray-600">测试 GraphQL 和 REST API</p>
      </div>

      <Tabs defaultValue="graphql" className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-2">
          <TabsTrigger value="graphql">GraphQL</TabsTrigger>
          <TabsTrigger value="rest">REST</TabsTrigger>
          <TabsTrigger value="docs">文档</TabsTrigger>
        </TabsList>

        <TabsContent value="graphql" className="flex-1 m-0">
          <GraphQLPlayground hasuraUrl={hasuraUrl} adminSecret={adminSecret} />
        </TabsContent>

        <TabsContent value="rest" className="flex-1 m-0">
          <RestClient openApiUrl={`/api/v1/projects/${projectId}/openapi`} />
        </TabsContent>

        <TabsContent value="docs" className="flex-1 m-0">
          <ApiDocumentation projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

---

## Summary

This plan implements all three Phase 5 P1 modules:

| Module | Tasks | Key Files |
|--------|-------|-----------|
| M4-CSV | 5 tasks | CsvImportDialog.tsx, import.routes.ts |
| M9 | 4 tasks | openapi.service.ts, ApiDocumentation.tsx |
| M5 | 4 tasks | GraphQLPlayground.tsx, RestClient.tsx, api/page.tsx |

Total: 13 tasks.
