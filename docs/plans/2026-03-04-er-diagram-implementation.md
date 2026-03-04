# M7: ER 图可视化实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在表列表页面添加 ER 图 Tab，使用 ReactFlow + dagre 自动布局展示表关系

**Architecture:** 后端新增外键查询 API，前端使用 ReactFlow 渲染自定义表节点，dagre 算法计算层次布局

**Tech Stack:** ReactFlow, @dagrejs/dagre, PostgreSQL information_schema

---

## Task 1: 安装前端依赖

**Files:**
- Modify: `apps/admin/package.json`

**Step 1: 安装 ReactFlow 和 dagre**

```bash
cd apps/admin && pnpm add reactflow @dagrejs/dagre @types/dagre
```

**Step 2: 验证安装**

Run: `pnpm list reactflow @dagrejs/dagre`
Expected: 显示已安装的版本

**Step 3: Commit**

```bash
git add apps/admin/package.json apps/admin/pnpm-lock.yaml
git commit -m "deps: add reactflow and dagre for ER diagram"
```

---

## Task 2: 后端 - 外键查询服务

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts`

**Step 1: 添加 ForeignKey 接口和查询函数**

在 `table.service.ts` 末尾添加：

```typescript
// Foreign key information
export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

// Get foreign keys in schema
export async function getForeignKeys(schemaName: string): Promise<ForeignKey[]> {
  const result = await query<{
    from_table: string;
    from_column: string;
    to_table: string;
    to_column: string;
  }>(
    `SELECT
       tc.table_name as from_table,
       kcu.column_name as from_column,
       ccu.table_name as to_table,
       ccu.column_name as to_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1`,
    [schemaName]
  );

  return result.map(row => ({
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toTable: row.to_table,
    toColumn: row.to_column,
  }));
}

// Get schema relations (tables with columns + foreign keys)
export async function getSchemaRelations(schemaName: string): Promise<{
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
  }>;
  foreignKeys: ForeignKey[];
}> {
  const tableList = await listTables(schemaName);
  const foreignKeys = await getForeignKeys(schemaName);

  const tables = await Promise.all(
    tableList.map(async (t) => {
      const meta = await getTableMetadata(schemaName, t.tableName);
      return {
        name: t.tableName,
        columns: meta?.columns.map(c => ({
          name: c.name,
          type: c.type,
          isPrimaryKey: c.isPrimaryKey,
        })) || [],
      };
    })
  );

  return { tables, foreignKeys };
}
```

**Step 2: Commit**

```bash
git add apps/api/src/modules/table/table.service.ts
git commit -m "feat(api): add foreign key and schema relations query"
```

---

## Task 3: 后端 - 外键查询路由

**Files:**
- Modify: `apps/api/src/modules/table/table.controller.ts`
- Modify: `apps/api/src/modules/table/table.routes.ts`

**Step 1: 添加 controller 方法**

在 `table.controller.ts` 中添加：

```typescript
import * as tableService from './table.service.js';

// ... existing code ...

// Get schema relations for ER diagram
export async function getSchemaRelations(
  request: FastifyRequest<{ Params: { schemaName: string } }>,
  reply: FastifyReply
) {
  const { schemaName } = request.params;

  try {
    const relations = await tableService.getSchemaRelations(schemaName);
    return reply.send({ success: true, data: relations });
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get schema relations' },
    });
  }
}
```

**Step 2: 添加路由**

在 `table.routes.ts` 中添加：

```typescript
// Get schema relations for ER diagram
app.get('/schemas/:schemaName/relations', controller.getSchemaRelations as never);
```

**Step 3: Commit**

```bash
git add apps/api/src/modules/table/table.controller.ts apps/api/src/modules/table/table.routes.ts
git commit -m "feat(api): add schema relations endpoint for ER diagram"
```

---

## Task 4: 前端 - API 方法

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

**Step 1: 添加 getSchemaRelations 方法**

在 `ApiClient` 类中添加：

```typescript
// Schema Relations for ER diagram
async getSchemaRelations(schemaName: string) {
  return this.request<{
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
    }>;
    foreignKeys: Array<{
      fromTable: string;
      fromColumn: string;
      toTable: string;
      toColumn: string;
    }>;
  }>('GET', `/api/v1/schemas/${schemaName}/relations`);
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/lib/api.ts
git commit -m "feat(admin): add getSchemaRelations API method"
```

---

## Task 5: 前端 - TableNode 组件

**Files:**
- Create: `apps/admin/src/components/tables/TableNode.tsx`

**Step 1: 创建自定义表节点组件**

```tsx
'use client';

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { KeyRound, Table2 } from 'lucide-react';

interface TableNodeData {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

export const TableNode = memo(function TableNode({ data }: { data: TableNodeData }) {
  return (
    <div className="bg-card border rounded-lg shadow-md min-w-[180px] max-w-[280px]">
      <Handle type="target" position={Position.Left} className="!bg-primary" />

      <div className="px-3 py-2 bg-primary text-primary-foreground font-medium rounded-t-lg flex items-center gap-2">
        <Table2 className="h-4 w-4" />
        <span className="truncate">{data.name}</span>
      </div>

      <div className="p-2 text-sm max-h-[200px] overflow-y-auto">
        {data.columns.map((col) => (
          <div
            key={col.name}
            className="flex items-center gap-2 py-1 px-1 hover:bg-muted rounded"
          >
            {col.isPrimaryKey ? (
              <KeyRound className="h-3 w-3 text-amber-500 flex-shrink-0" />
            ) : (
              <span className="w-3" />
            )}
            <span className="font-mono text-xs truncate flex-1">{col.name}</span>
            <span className="text-muted-foreground text-xs flex-shrink-0">
              {col.type}
            </span>
          </div>
        ))}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
});
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/tables/TableNode.tsx
git commit -m "feat(admin): add TableNode component for ER diagram"
```

---

## Task 6: 前端 - ERDiagram 组件

**Files:**
- Create: `apps/admin/src/components/tables/ERDiagram.tsx`

**Step 1: 创建 ER 图主组件**

```tsx
'use client';

import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
  ReactFlowProvider,
} from 'reactflow';
import dagre from '@dagrejs/dagre';
import 'reactflow/dist/style.css';

import { TableNode } from './TableNode';

interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface ERDiagramProps {
  tables: TableInfo[];
  foreignKeys: ForeignKey[];
  onTableClick?: (tableName: string) => void;
}

const nodeTypes = { tableNode: TableNode };

const NODE_WIDTH = 220;
const NODE_HEADER_HEIGHT = 40;
const NODE_ROW_HEIGHT = 28;
const NODE_PADDING = 16;

function calculateNodeHeight(columnCount: number): number {
  return NODE_HEADER_HEIGHT + Math.min(columnCount, 8) * NODE_ROW_HEIGHT + NODE_PADDING;
}

function getLayoutedElements(
  tables: TableInfo[],
  foreignKeys: ForeignKey[]
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 120 });

  // Add nodes with dynamic height
  tables.forEach((table) => {
    const height = calculateNodeHeight(table.columns.length);
    dagreGraph.setNode(table.name, { width: NODE_WIDTH, height });
  });

  // Add edges
  foreignKeys.forEach((fk) => {
    dagreGraph.setEdge(fk.fromTable, fk.toTable);
  });

  // Calculate layout
  dagre.layout(dagreGraph);

  // Create React Flow nodes
  const nodes: Node[] = tables.map((table) => {
    const nodeWithPosition = dagreGraph.node(table.name);
    const height = calculateNodeHeight(table.columns.length);
    return {
      id: table.name,
      type: 'tableNode',
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - height / 2,
      },
      data: table,
    };
  });

  // Create React Flow edges
  const edges: Edge[] = foreignKeys.map((fk, index) => ({
    id: `fk-${index}`,
    source: fk.fromTable,
    target: fk.toTable,
    label: `${fk.fromColumn} → ${fk.toColumn}`,
    type: 'smoothstep',
    animated: true,
    style: { stroke: 'hsl(var(--primary))' },
    labelStyle: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' },
  }));

  return { nodes, edges };
}

export function ERDiagram({ tables, foreignKeys, onTableClick }: ERDiagramProps) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => getLayoutedElements(tables, foreignKeys),
    [tables, foreignKeys]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = getLayoutedElements(tables, foreignKeys);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [tables, foreignKeys, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onTableClick?.(node.id);
    },
    [onTableClick]
  );

  if (tables.length === 0) {
    return (
      <div className="h-[500px] border rounded-lg flex items-center justify-center text-muted-foreground">
        暂无数据表，请先创建表
      </div>
    );
  }

  return (
    <div className="h-[500px] border rounded-lg">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
        >
          <Background color="hsl(var(--muted-foreground))" gap={16} size={1} />
          <Controls />
          <MiniMap
            nodeColor="hsl(var(--primary))"
            maskColor="hsl(var(--background) / 0.8)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/components/tables/ERDiagram.tsx
git commit -m "feat(admin): add ERDiagram component with dagre layout"
```

---

## Task 7: 前端 - 集成到表页面

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`

**Step 1: 重构页面添加 Tabs**

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, Table2, GitBranch } from 'lucide-react';
import { CreateTableDialog } from '@/components/CreateTableDialog';
import { ERDiagram } from '@/components/tables/ERDiagram';

interface TableInfo {
  tableName: string;
  rowCount: number;
  sizeBytes: number;
}

interface TableWithColumns {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function TablesPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant } = useAppStore();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // ER diagram data
  const [tablesWithColumns, setTablesWithColumns] = useState<TableWithColumns[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([]);
  const [erLoading, setErLoading] = useState(false);
  const [erError, setErError] = useState<string | null>(null);

  const fetchTables = async () => {
    if (!currentProject?.schemaName) return;
    const res = await api.listTables(currentProject.schemaName);
    if (res.success && res.data) {
      setTables(res.data);
    }
    setLoading(false);
  };

  const fetchERData = async () => {
    if (!currentProject?.schemaName) return;
    setErLoading(true);
    setErError(null);
    const res = await api.getSchemaRelations(currentProject.schemaName);
    if (res.success && res.data) {
      setTablesWithColumns(res.data.tables);
      setForeignKeys(res.data.foreignKeys);
    } else {
      setErError(res.error?.message || '加载失败');
    }
    setErLoading(false);
  };

  useEffect(() => {
    fetchTables();
  }, [currentProject?.schemaName]);

  const handleTabChange = (value: string) => {
    if (value === 'er' && tablesWithColumns.length === 0) {
      fetchERData();
    }
  };

  const handleTableClick = (tableName: string) => {
    router.push(`/t/${tenantId}/p/${projectId}/tables/${tableName}`);
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href={`/t/${tenantId}`} className="hover:text-foreground">
              {currentTenant?.name}
            </Link>
            <span>/</span>
            <Link
              href={`/t/${tenantId}/p/${projectId}`}
              className="hover:text-foreground"
            >
              {currentProject?.name}
            </Link>
            <span>/</span>
            <span>数据表</span>
          </div>
          <h1 className="text-2xl font-bold">数据表</h1>
        </div>
        {currentProject?.schemaName && (
          <CreateTableDialog
            schemaName={currentProject.schemaName}
            onSuccess={fetchTables}
          />
        )}
      </div>

      <Tabs defaultValue="list" onValueChange={handleTabChange}>
        <TabsList className="mb-4">
          <TabsTrigger value="list" className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            表列表
          </TabsTrigger>
          <TabsTrigger value="er" className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            关系图
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list">
          <div className="border rounded-lg">
            {loading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : tables.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-muted-foreground mb-4">暂无数据表</p>
                {currentProject?.schemaName && (
                  <CreateTableDialog
                    schemaName={currentProject.schemaName}
                    onSuccess={fetchTables}
                    trigger={
                      <Button>
                        <Plus className="h-4 w-4 mr-2" />
                        创建第一个表
                      </Button>
                    }
                  />
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>表名</TableHead>
                    <TableHead className="text-right">行数</TableHead>
                    <TableHead className="text-right">大小</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((table) => (
                    <TableRow key={table.tableName}>
                      <TableCell className="font-medium font-mono">
                        {table.tableName}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {table.rowCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatBytes(table.sizeBytes)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link
                            href={`/t/${tenantId}/p/${projectId}/tables/${table.tableName}`}
                          >
                            查看
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="er">
          {erLoading ? (
            <div className="h-[500px] border rounded-lg flex items-center justify-center">
              <div className="text-center">
                <Skeleton className="h-8 w-8 rounded-full mx-auto mb-2" />
                <span className="text-muted-foreground">加载中...</span>
              </div>
            </div>
          ) : erError ? (
            <div className="h-[500px] border rounded-lg flex items-center justify-center">
              <div className="text-center">
                <p className="text-destructive mb-4">{erError}</p>
                <Button variant="outline" onClick={fetchERData}>
                  重试
                </Button>
              </div>
            </div>
          ) : (
            <ERDiagram
              tables={tablesWithColumns}
              foreignKeys={foreignKeys}
              onTableClick={handleTableClick}
            />
          )}
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}
```

**Step 2: Commit**

```bash
git add apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx
git commit -m "feat(admin): integrate ER diagram into tables page"
```

---

## Task 8: 测试验证

**Step 1: 启动开发环境**

```bash
make dev-up
pnpm dev
```

**Step 2: 手动测试**

1. 登录管理后台
2. 进入一个项目的数据表页面
3. 创建 2-3 个表并添加外键关系
4. 切换到"关系图" Tab
5. 验证：
   - 表节点正确显示
   - 外键连线正确
   - 可以拖拽节点
   - 可以缩放画布
   - 点击节点跳转到表详情

**Step 3: Final Commit**

```bash
git add -A
git commit -m "feat: complete M7 ER diagram visualization

- Add foreign key query API
- Create ReactFlow + dagre ER diagram component
- Integrate into tables page with tabs"
```

---

## 验收标准

- [x] 依赖安装：reactflow, @dagrejs/dagre
- [ ] 后端 API：`GET /schemas/:schemaName/relations`
- [ ] 前端组件：ERDiagram, TableNode
- [ ] 页面集成：表列表页添加"关系图" Tab
- [ ] 自动从外键生成关系图
- [ ] 表节点显示表名和字段
- [ ] 主键字段有图标标识
- [ ] 关系线显示外键关联
- [ ] 可拖拽调整布局
- [ ] 可缩放/平移画布
- [ ] 有 MiniMap 导航
- [ ] 点击表节点跳转到表详情
