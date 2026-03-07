# 开发者体验增强设计文档

## 概述

从租户->项目开发应用的使用者角度，增强 Druvia 平台的开发者体验，聚焦**快速原型开发**场景。

## 目标用户

- 租户用户 = 项目管理用户（现阶段）
- 需要快速建表、插入测试数据、验证 API 的开发者

---

## 竞品分析：InsForge

> **来源**: https://github.com/InsForge/InsForge
> **定位**: AI-native 后端平台，Supabase 替代品

### InsForge 核心特点

| 维度 | InsForge | Druvia |
|------|----------|--------|
| **定位** | AI agents 开发平台 | 企业级多租户 BaaS |
| **数据隔离** | Row-Level Security | Schema-per-Tenant |
| **数据网格** | react-data-grid | @svar-ui/react-grid |
| **AI 集成** | ✅ MCP 协议 | ❌ |

### 可借鉴功能

| 功能 | InsForge 实现 | 借鉴优先级 |
|------|--------------|-----------|
| SQL 多标签 | 标签页管理、可重命名 | **P1** |
| CSV 导入 | useCSVImport Hook | **P1** |
| 外键配置 | ForeignKeyPopover 弹出框 | P2 |
| 侧边栏表列表 | TableSidebar 快速切换 | P2 |
| JSON 编辑器 | JsonCellEditor 语法高亮 | P2 |
| 记录详情表单 | RecordFormDialog 弹窗 | P3 |
| MCP 集成 | 让 AI 直接操作后端 | P3 |

---

## 模块规划

### 原有模块

| 模块 | 优先级 | 说明 | 开源方案 |
|------|--------|------|---------|
| M1: 表数据 CRUD | P0 | 查看/编辑/删除行数据 | SVAR DataGrid + 适配层 |
| M2: 快速建表 | P0 | 模板建表、字段向导 | 自研 |
| M3: SQL 编辑器增强 | P1 | 语法高亮、自动完成、**多标签** | @uiw/react-codemirror |
| M4: 数据库导入导出 | P1 | SQL/CSV 导入导出 | 自研 |
| M5: API 测试工具 | P2 | GraphQL/REST 测试 | @graphiql/react |
| M6: 数据生成器 | P2 | Faker 测试数据 | @faker-js/faker |
| M7: 表关系可视化 | P2 | ER 图展示 | reactflow |
| M8: Schema 版本控制 | P3 | 迁移历史、回滚 | pgroll |
| M9: API 文档生成 | P3 | OpenAPI/GraphQL Schema | 自研 |
| M10: 环境管理 | P3 | 开发/测试/生产切换 | 自研 |

### 新增模块（借鉴 InsForge）

| 模块 | 优先级 | 说明 | 开源方案 |
|------|--------|------|---------|
| M11: 外键关系配置 | P2 | 建表时配置外键、级联规则 | 自研 |
| M12: 侧边栏表列表 | P2 | 数据浏览页快速切换表 | 自研 |
| M13: JSON 单元格编辑器 | P2 | jsonb 类型语法高亮编辑 | @uiw/react-codemirror |
| M14: 记录详情表单 | P3 | 弹窗式完整字段编辑 | react-hook-form + zod |
| M15: 表单验证增强 | P3 | zod schema 验证 | zod |
| M16: MCP 集成 | P3 | 让 AI 工具操作 Druvia | @modelcontextprotocol/sdk |

---

## 外部依赖调查汇总

| 包名 | 版本 | 许可证 | 大小 | React 版本 | 用途 |
|------|------|--------|------|-----------|------|
| @svar-ui/react-grid | 2.5.2 | MIT | ~500KB | >=18 | 表格组件 |
| @uiw/react-codemirror | 4.25.5 | MIT | ~200KB | >=17 | SQL 编辑器 |
| @codemirror/lang-sql | 6.10.0 | MIT | ~50KB | - | SQL 语法支持 |
| @graphiql/react | 0.37.3 | MIT | ~300KB | >=18 | GraphQL IDE |
| @faker-js/faker | 10.3.0 | MIT | ~2MB | - | 测试数据生成 |
| reactflow | 11.11.4 | MIT | ~400KB | >=17 | ER 图绘制 |

---

## M1: 表数据 CRUD

### 页面位置
`/t/[tenantId]/p/[projectId]/tables/[tableName]/data`

### 技术方案：SVAR DataGrid + 自定义适配层

#### 为什么选择 SVAR DataGrid

| 特性 | SVAR DataGrid | 现有 @tanstack/react-table |
|------|--------------|---------------------------|
| 虚拟滚动 | ✅ 内置 | ❌ 需额外实现 |
| 行内编辑 | ✅ 内置多种编辑器 | ❌ 需自行实现 |
| 列冻结 | ✅ 内置 | ❌ 需额外实现 |
| 拖拽排序 | ✅ 内置 | ❌ 需额外实现 |
| 上下文菜单 | ✅ 内置 | ❌ 需自行实现 |
| 包大小 | ~500KB | ~50KB |

#### API 兼容性问题

现有 Druvia API 与 SVAR RestDataProvider 期望不兼容：

| 操作 | Druvia API | SVAR 期望 |
|------|-----------|----------|
| 响应格式 | `{ success, data: {...} }` | 直接返回数据 |
| 更新 | `PATCH /rows` body: `{ primaryKey, data }` | `PUT /rows/:id` |
| 删除 | `DELETE /rows` body: `{ primaryKey }` | `DELETE /rows/:id` |

#### 解决方案：自定义 DruviaDataProvider

创建适配层，在前端转换 API 调用：

```typescript
// apps/admin/src/lib/druvia-data-provider.ts
import { api } from './api';

export class DruviaDataProvider {
  constructor(
    private schemaName: string,
    private tableName: string,
    private primaryKeyColumn: string = 'id'
  ) {}

  // 获取数据 - 转换响应格式
  async getData(options?: { limit?: number; offset?: number }) {
    const res = await api.listRows(this.schemaName, this.tableName, options);
    if (!res.success || !res.data) throw new Error('Failed to load data');
    return res.data.rows;
  }

  // 处理 Grid 事件
  async handleEvent(event: string, payload: any) {
    switch (event) {
      case 'add-row':
        return this.addRow(payload.row);
      case 'update-row':
        return this.updateRow(payload.id, payload.row);
      case 'delete-row':
        return this.deleteRow(payload.id);
    }
  }

  private async addRow(row: Record<string, unknown>) {
    const res = await api.createRow(this.schemaName, this.tableName, row);
    if (!res.success) throw new Error(res.error?.message || 'Create failed');
    return res.data;
  }

  private async updateRow(id: unknown, data: Record<string, unknown>) {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.updateRow(this.schemaName, this.tableName, primaryKey, data);
    if (!res.success) throw new Error(res.error?.message || 'Update failed');
    return res.data;
  }

  private async deleteRow(id: unknown) {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.deleteRow(this.schemaName, this.tableName, primaryKey);
    if (!res.success) throw new Error(res.error?.message || 'Delete failed');
  }
}
```

#### 集成示例

```tsx
import { Grid } from "@svar-ui/react-grid";
import "@svar-ui/react-grid/all.css";
import { DruviaDataProvider } from "@/lib/druvia-data-provider";

function TableDataPage({ schemaName, tableName }) {
  const [data, setData] = useState([]);
  const provider = useMemo(
    () => new DruviaDataProvider(schemaName, tableName),
    [schemaName, tableName]
  );

  useEffect(() => {
    provider.getData().then(setData);
  }, [provider]);

  const init = (api) => {
    // 拦截事件，调用适配层
    api.on('add-row', async (ev) => {
      await provider.handleEvent('add-row', ev);
    });
    api.on('update-row', async (ev) => {
      await provider.handleEvent('update-row', ev);
    });
    api.on('delete-row', async (ev) => {
      await provider.handleEvent('delete-row', ev);
    });
  };

  return <Grid data={data} columns={columns} init={init} />;
}
```

### 功能设计

| 功能 | 说明 | 实现方式 |
|------|------|---------|
| 数据表格 | 分页展示、排序、筛选、虚拟滚动 | SVAR Grid 内置 |
| 新增行 | 行内新增或弹窗表单 | Grid + 适配层 |
| 编辑行 | 行内编辑，支持多种编辑器 | Grid editor 属性 |
| 删除行 | 单行删除 + 批量删除 | Grid + 适配层 |
| 搜索 | 按字段筛选 | Grid filter 属性 |
| 导出 | 导出当前视图为 CSV/JSON | 复用现有 API |

### 字段类型 → 编辑器映射

| PostgreSQL 类型 | SVAR 编辑器 |
|----------------|------------|
| varchar/text | `editor: 'text'` |
| integer/bigint | `editor: 'text'` + 数字验证 |
| boolean | `editor: 'checkbox'` |
| timestamp/date | `editor: 'datepicker'` |
| jsonb | 自定义 JSON 编辑器 |
| uuid | `editor: 'text'` + 自动生成按钮 |

---

## M2: 快速建表模板

### 页面位置
创建表页面新增 "从模板创建" 选项

### 技术方案
自研，扩展现有 CreateTableDialog 组件

### 预设模板

| 模板 | 字段 |
|------|------|
| 用户表 | id, email, username, password_hash, avatar_url, status, created_at, updated_at |
| 文章表 | id, title, slug, content, author_id, status, published_at, created_at, updated_at |
| 订单表 | id, order_no, user_id, total_amount, status, paid_at, created_at, updated_at |
| 产品表 | id, name, description, price, stock, category, created_at, updated_at |
| 评论表 | id, content, user_id, target_type, target_id, created_at |

---

## M3: SQL 编辑器增强

### 页面位置
`/t/[tenantId]/p/[projectId]/database`

### 外部依赖详情

#### @uiw/react-codemirror
- **版本**: 4.25.5
- **许可证**: MIT
- **仓库**: https://github.com/uiwjs/react-codemirror
- **特点**: CodeMirror 6 的 React 封装，支持 React 17+
- **peer 依赖**: `@codemirror/state`, `@codemirror/view`, `codemirror`

#### @codemirror/lang-sql
- **版本**: 6.10.0
- **许可证**: MIT
- **特点**: SQL 语法高亮、自动完成

### 功能设计

| 功能 | 实现方案 |
|------|---------|
| 语法高亮 | `@codemirror/lang-sql` |
| 自动完成 | 从 schema 元数据获取表名/字段名，注入 completion |
| 格式化 | `sql-formatter` 库 |
| 快捷键 | Cmd/Ctrl+Enter 执行，Cmd/Ctrl+Shift+F 格式化 |
| 主题 | 使用 `@uiw/codemirror-theme-*` 系列 |
| **多标签** | 🆕 借鉴 InsForge，支持多查询标签页 |

### 🆕 多标签功能设计（借鉴 InsForge）

```tsx
interface SqlTab {
  id: string;
  name: string;           // 可重命名
  query: string;
  result?: QueryResult;
  status?: 'idle' | 'running' | 'success' | 'error';
}

// 标签管理
const [tabs, setTabs] = useState<SqlTab[]>([{ id: '1', name: '查询 1', query: '' }]);
const [activeTabId, setActiveTabId] = useState('1');

// UI: 标签栏 + 编辑器 + 结果面板
<TabBar tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId} />
<SqlEditor value={activeTab.query} onChange={updateQuery} />
<ResultPanel result={activeTab.result} status={activeTab.status} />
```

### 集成示例

```tsx
import CodeMirror from '@uiw/react-codemirror';
import { sql, PostgreSQL } from '@codemirror/lang-sql';

function SqlEditor({ onExecute, schema }) {
  const [value, setValue] = useState('');

  // 从 schema 构建自动完成
  const sqlConfig = useMemo(() => sql({
    dialect: PostgreSQL,
    schema: schema, // { tableName: ['col1', 'col2'] }
  }), [schema]);

  return (
    <CodeMirror
      value={value}
      extensions={[sqlConfig]}
      onChange={setValue}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          onExecute(value);
        }
      }}
    />
  );
}
```

---

## M4: 数据库导入导出

### 与现有备份功能关系

| 功能 | 现有实现 | 新增 |
|------|---------|------|
| 备份（pg_dump 二进制） | ✅ 已有 | 复用 |
| 还原（pg_restore） | ✅ 已有 | 复用 |
| 导出 SQL 文本 | ❌ | 🆕 新增 |
| 导入 SQL 文件 | ❌ | 🆕 新增 |
| **导入 CSV** | ❌ | 🆕 新增（借鉴 InsForge） |

### 新增 API

> **安全修正**：API 路径包含租户作用域，与现有备份 API 保持一致，防止跨租户越权。

```
# SQL 导出
GET /api/v1/projects/:projectId/export-sql?type=full|schema-only|data-only
  返回: SQL 文件下载

# SQL 导入
POST /api/v1/projects/:projectId/import-sql
  Body: { sql: string }
  返回: { success, statementsExecuted, errors }

# 🆕 CSV 导入（借鉴 InsForge）
POST /api/v1/schemas/:schema/tables/:table/import-csv
  Body: FormData (file) 或 { csv: string, options: { skipHeader?, delimiter? } }
  返回: { success, inserted, skipped, errors }
```

### 🆕 CSV 导入功能设计（借鉴 InsForge）

**后端实现：**
```typescript
// apps/api/src/modules/data/data.service.ts
async function importCSV(
  schemaName: string,
  tableName: string,
  csvContent: string,
  options?: {
    skipHeader?: boolean;
    delimiter?: string;
    batchSize?: number;
    skipErrors?: boolean;
  }
): Promise<{ inserted: number; skipped: number; errors: string[] }>
```

**前端组件：**
```tsx
// apps/admin/src/components/CSVImportDialog.tsx
<CSVImportDialog
  schemaName={schemaName}
  tableName={tableName}
  columns={columns}
  onSuccess={() => fetchData()}
>
  {/* 步骤1: 上传文件 */}
  {/* 步骤2: 列映射预览 */}
  {/* 步骤3: 确认导入 */}
</CSVImportDialog>
```

### 页面位置
`/t/[tenantId]/p/[projectId]/database` 新增 "导入导出" Tab

### 安全考虑
1. 权限检查 — 仅项目所有者/管理员可执行
2. 大小限制 — 导入文件限制 100MB
3. 超时控制 — 导入操作 5 分钟超时
4. 事务保护 — 导入失败自动回滚
5. Schema 隔离 — 只能操作自己的 Schema

---

## M5: API 测试工具

### 页面位置
`/t/[tenantId]/p/[projectId]/api` 新增 "测试" Tab

### 外部依赖详情

#### @graphiql/react
- **版本**: 0.37.3
- **许可证**: MIT
- **仓库**: https://github.com/graphql/graphiql
- **特点**: 官方 GraphQL IDE React 组件
- **peer 依赖**: `graphql ^15.5.0 || ^16.0.0 || ^17.0.0`, `react ^18 || ^19`

### 功能设计

| 功能 | 说明 |
|------|------|
| GraphQL Playground | 内嵌 GraphiQL，连接 Hasura 端点 |
| REST 测试 | 简易 HTTP 客户端（自研） |

### 集成示例

```tsx
import { GraphiQL } from '@graphiql/react';
import '@graphiql/react/dist/style.css';

function GraphQLPlayground({ endpoint, headers }) {
  const fetcher = async (params) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(params),
    });
    return res.json();
  };

  return <GraphiQL fetcher={fetcher} />;
}
```

---

## M6: 数据生成器

### 页面位置
表数据页面新增 "生成测试数据" 按钮

### 外部依赖详情

#### @faker-js/faker
- **版本**: 10.3.0
- **许可证**: MIT
- **仓库**: https://github.com/faker-js/faker
- **特点**: 功能丰富的假数据生成库
- **大小**: ~2MB（建议动态导入）

### 字段映射规则

| 字段名/类型 | Faker 方法 |
|------------|-----------|
| email | `faker.internet.email()` |
| username | `faker.internet.username()` |
| password_hash | `faker.string.alphanumeric(60)` |
| name | `faker.person.fullName()` |
| title | `faker.lorem.sentence()` |
| content/text | `faker.lorem.paragraphs()` |
| integer | `faker.number.int({ min, max })` |
| timestamp | `faker.date.recent()` |
| boolean | `faker.datatype.boolean()` |
| uuid | `faker.string.uuid()` |

### 集成示例

```tsx
// 动态导入减少初始包大小
const generateTestData = async (columns, count) => {
  const { faker } = await import('@faker-js/faker');

  return Array.from({ length: count }, () => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      row[col.name] = generateValue(faker, col);
    }
    return row;
  });
};
```

---

## M7: 表关系可视化

### 页面位置
`/t/[tenantId]/p/[projectId]/tables` 新增 "关系图" Tab

### 外部依赖详情

#### reactflow
- **版本**: 11.11.4
- **许可证**: MIT
- **仓库**: https://github.com/xyflow/xyflow
- **特点**: 高性能流程图/关系图库
- **peer 依赖**: `react >=17`, `react-dom >=17`

### 实现方案
从外键关系自动生成 ER 图：

```tsx
import ReactFlow, { Background, Controls } from 'reactflow';
import 'reactflow/dist/style.css';

function ERDiagram({ tables, foreignKeys }) {
  const nodes = tables.map((t, i) => ({
    id: t.name,
    position: { x: (i % 3) * 300, y: Math.floor(i / 3) * 200 },
    data: { label: <TableNode table={t} /> },
  }));

  const edges = foreignKeys.map((fk) => ({
    id: `${fk.from}-${fk.to}`,
    source: fk.fromTable,
    target: fk.toTable,
    label: `${fk.fromColumn} → ${fk.toColumn}`,
  }));

  return (
    <ReactFlow nodes={nodes} edges={edges}>
      <Background />
      <Controls />
    </ReactFlow>
  );
}
```

---

## M8: Schema 版本控制

### 外部依赖详情

#### pgroll
- **版本**: 最新
- **许可证**: Apache 2.0
- **仓库**: https://github.com/xataio/pgroll
- **特点**: PostgreSQL 零停机迁移工具

### 功能

| 功能 | 说明 |
|------|------|
| 迁移历史 | 记录每次 DDL 变更 |
| 回滚 | 支持回滚到指定版本 |
| 零停机 | 新旧 schema 并存 |

### 存储
`_meta_migrations` 表记录迁移历史

---

## M9: API 文档生成

### 功能

| 格式 | 说明 |
|------|------|
| OpenAPI 3.0 | 基于表结构自动生成 REST API 文档 |
| GraphQL Schema | 导出 SDL 文件 |

### 页面位置
`/t/[tenantId]/p/[projectId]/api` 新增 "文档" Tab

---

## M10: 环境管理

> **⚠️ 待细化**：此模块设计不完整，需要进一步明确：
> 1. 页面/API 路由如何区分 env 维度
> 2. 用户如何切换环境
> 3. 环境间数据同步机制
> 4. 与现有 schemaName 命名规则的兼容性

### 环境类型

| 环境 | 说明 |
|------|------|
| 开发 | 默认环境，可自由修改 |
| 测试 | 从开发环境克隆 |
| 生产 | 需审批才能修改 |

### 实现（草案）
每个环境对应独立 Schema（如 `dru_tenant_project_dev`）

---

## M11: 外键关系配置（借鉴 InsForge）

### 页面位置
CreateTableDialog 组件内新增外键配置区域

### 功能设计

| 功能 | 说明 |
|------|------|
| 外键选择 | 选择目标表和目标列 |
| 级联规则 | ON DELETE / ON UPDATE 配置 |
| 可视化显示 | 数据网格中外键列可点击跳转 |

### 实现方案

```tsx
// apps/admin/src/components/ForeignKeyPopover.tsx
interface ForeignKeyConfig {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

<ForeignKeyPopover
  columns={columns}
  availableTables={tables}
  onAdd={(fk) => setForeignKeys([...foreignKeys, fk])}
/>
```

### 后端支持
扩展 createTable API 支持外键定义

---

## M12: 侧边栏表列表（借鉴 InsForge）

### 页面位置
`/t/[tenantId]/p/[projectId]/tables/[tableName]/data`

### 功能设计

| 功能 | 说明 |
|------|------|
| 表列表 | 显示所有表，支持搜索 |
| 快速切换 | 点击切换当前查看的表 |
| 表数量 | 显示表总数 |

### 实现方案

```tsx
// apps/admin/src/components/TableSidebar.tsx
<div className="flex h-full">
  <TableSidebar
    tables={tables}
    selectedTable={tableName}
    onSelect={(name) => router.push(`/.../tables/${name}/data`)}
  />
  <div className="flex-1">
    <SvarDataGrid ... />
  </div>
</div>
```

---

## M13: JSON 单元格编辑器（借鉴 InsForge）

### 功能设计

| 功能 | 说明 |
|------|------|
| 语法高亮 | JSON 语法着色 |
| 格式化 | 自动格式化 JSON |
| 验证 | 实时验证 JSON 语法 |
| 弹窗编辑 | 大文本使用弹窗编辑器 |

### 实现方案

```tsx
// apps/admin/src/components/JsonCellEditor.tsx
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

function JsonCellEditor({ value, onChange }) {
  return (
    <Dialog>
      <CodeMirror
        value={JSON.stringify(value, null, 2)}
        extensions={[json()]}
        onChange={(v) => onChange(JSON.parse(v))}
      />
    </Dialog>
  );
}
```

---

## M14: 记录详情表单（借鉴 InsForge）

### 功能设计

| 功能 | 说明 |
|------|------|
| 弹窗表单 | 完整字段编辑界面 |
| 字段验证 | 类型验证、必填检查 |
| 外键选择 | 下拉选择关联记录 |

### 实现方案

```tsx
// apps/admin/src/components/RecordFormDialog.tsx
<RecordFormDialog
  columns={columns}
  record={selectedRecord}
  foreignKeys={foreignKeys}
  onSave={handleSave}
/>
```

---

## M15: 表单验证增强（借鉴 InsForge）

### 技术方案
引入 zod + react-hook-form

### 实现示例

```typescript
import { z } from 'zod';

const columnSchema = z.object({
  name: z.string().min(1).regex(/^[a-z_][a-z0-9_]*$/i, '无效的列名'),
  type: z.string(),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().optional(),
});

const tableSchema = z.object({
  name: z.string().min(1).max(63),
  columns: z.array(columnSchema).min(1, '至少需要一个列'),
});
```

---

## M16: MCP 集成（借鉴 InsForge）

### 概述
实现 Model Context Protocol 服务器，让各种 AI 工具能直接操作 Druvia。

### 支持的 AI 工具
- Claude Code、Cursor、Windsurf、Cline、Kiro
- GitHub Copilot、Codex、Roo Code
- Google Antigravity、Gemini CLI
- 其他支持 MCP 协议的工具

### 功能设计

| 工具 | 说明 |
|------|------|
| fetch_docs | 获取 Druvia 使用文档 |
| list_tables | 列出所有表 |
| get_table_schema | 获取表结构 |
| query_data | 执行 SELECT 查询 |
| insert_row | 插入数据 |
| update_row | 更新数据 |
| create_table | 创建表 |
| list_buckets | 列出存储桶 |
| upload_file | 上传文件 |

### 实现方案对比

| 方案 | 说明 | 优点 | 缺点 | 复杂度 |
|------|------|------|------|--------|
| **A: 独立 npm 包** | `@druvia/mcp` 独立发布 | 解耦、用户 npx 即用 | 需维护独立包 | 中 |
| **B: 内置 API 端点** | `/api/mcp` 在 Fastify 实现 | 简单、无需额外部署 | 耦合主项目 | 低 |
| **C: 远程 MCP 服务** | 托管 MCP Server | 用户无需本地运行 | 需云服务支持 | 高 |

**推荐方案 A**：参考 InsForge `@insforge/mcp` 模式

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Coding Assistants                      │
│  (Claude Code, Cursor, Copilot, Windsurf, Cline, Kiro...)   │
└─────────────────────────┬───────────────────────────────────┘
                          │ MCP Protocol (stdio/HTTP)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              @druvia/mcp (npm package)                       │
│  • 本地运行: npx @druvia/mcp                                 │
│  • 依赖: @modelcontextprotocol/sdk                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ REST API (API_KEY + API_BASE_URL)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Druvia Backend API                         │
│  /api/v1/tables, /api/v1/sql, /api/v1/storage...            │
└─────────────────────────────────────────────────────────────┘
```

### 认证方式
- 环境变量：`DRUVIA_API_KEY` + `DRUVIA_API_URL`
- 支持项目级 API Key（需新增 API Key 管理功能）

### 使用方式

```json
// .mcp.json 或 claude_desktop_config.json
{
  "mcpServers": {
    "druvia": {
      "command": "npx",
      "args": ["-y", "@druvia/mcp@latest"],
      "env": {
        "DRUVIA_API_KEY": "your-api-key",
        "DRUVIA_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

### 代码示例

```typescript
// packages/mcp-server/src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'druvia-mcp',
  version: '1.0.0',
});

server.tool('list_tables', { schemaName: z.string() }, async ({ schemaName }) => {
  const tables = await api.listTables(schemaName);
  return { tables };
});

server.tool('query_data', {
  schemaName: z.string(),
  sql: z.string()
}, async ({ schemaName, sql }) => {
  const result = await api.executeQuery(schemaName, sql);
  return result;
});
```

---

## 技术栈汇总

| 类别 | 技术 | 版本 | 许可证 |
|------|------|------|--------|
| 表格组件 | @svar-ui/react-grid | 2.5.2 | MIT |
| 代码编辑器 | @uiw/react-codemirror | 4.25.5 | MIT |
| SQL 语法 | @codemirror/lang-sql | 6.10.0 | MIT |
| JSON 语法 | @codemirror/lang-json | 6.0.0 | MIT |
| SQL 格式化 | sql-formatter | 15.0.0 | MIT |
| GraphQL IDE | @graphiql/react | 0.37.3 | MIT |
| 测试数据 | @faker-js/faker | 10.3.0 | MIT |
| ER 图 | reactflow | 11.11.4 | MIT |
| 迁移工具 | pgroll | latest | Apache 2.0 |
| 表单验证 | zod | 3.23.0 | MIT |
| 表单管理 | react-hook-form | 7.54.0 | MIT |
| MCP SDK | @modelcontextprotocol/sdk | latest | MIT |

---

## 实施顺序

### Phase 1 (P0) ✅ 已完成
1. M1: 表数据 CRUD — 集成 SVAR DataGrid + DruviaDataProvider 适配层
2. M2: 快速建表模板

### Phase 2 (P1) ✅ 已完成
3. M3: SQL 编辑器增强 — 语法高亮、自动完成、多标签
4. M4: 数据库导入导出 — SQL 导入导出 (CSV 导入移至 Phase 5)

### Phase 3 (P2) ✅ 已完成
5. M7: 表关系可视化 — 集成 reactflow + dagre 自动布局
6. M11: 外键关系配置 — 建表/编辑表时配置外键
7. M12: 侧边栏表列表 — 快速切换表、搜索过滤
8. M13: JSON 单元格编辑器 — 语法高亮、格式化、弹窗编辑
9. M14: 记录详情表单 — 字段类型适配、外键下拉

### Phase 4 (P2) ✅ 已完成
10. M17: Authentication 管理界面 — OAuth 配置、用户管理
11. M18: Storage 管理界面 — Buckets、文件管理、访问控制
12. M19: Edge Functions — Deno Worker + 管理 UI
13. M20: Realtime 管理界面 — Hasura Subscriptions 可视化

### Phase 5 P1 ✅ 已完成
14. M4-CSV: CSV 导入 — 列映射、批量导入
15. M5: API 测试工具 — 集成 @graphiql/react
16. M9: API 文档生成 — OpenAPI/GraphQL Schema

### Phase 5 P2 ⏳ 待开发
17. M6: 数据生成器 — 集成 @faker-js/faker
18. M15: 表单验证增强 — zod + react-hook-form
19. M21: 单租户模式重构 — 默认单租户→多项目，保留多租户逻辑结构
20. M16: MCP 集成 — Claude Code 操作 Druvia
21. M10: 环境管理

### 后续考虑 (上线后)
- M8: Schema 版本控制 — 集成 pgroll

---

## 验收标准

### M1 表数据 CRUD ✅
- [x] 可分页查看表数据（虚拟滚动）
- [x] 可行内编辑数据
- [x] 可新增/删除行
- [x] 支持批量操作
- [x] 适配层正确转换 API 调用
- [x] 时区问题修复
- [x] 时间编辑器支持

### M2 快速建表 ✅
- [x] 可选择预设模板
- [x] 模板自动填充表名和字段
- [x] 支持 5 种常用模板

### M3 SQL 编辑器增强 ✅
- [x] SQL 语法高亮
- [x] 表名/字段名自动完成
- [x] Cmd/Ctrl + Enter 执行
- [x] SQL 格式化
- [x] 多标签支持

### M4 导入导出 (部分完成)
- [x] 可导出完整 SQL
- [x] 可导出仅结构/仅数据
- [x] 可导入 SQL 文件
- [x] 导入失败自动回滚
- [ ] CSV 导入支持 (移至 Phase 5)

### M7 表关系可视化 ✅
- [x] 自动从外键生成关系图
- [x] 表节点显示表名和字段
- [x] 关系线显示外键关联
- [x] 可拖拽调整布局
- [x] 可缩放/平移画布
- [x] 点击表节点跳转到表详情

### M11 外键关系配置 ✅
- [x] 可在建表时配置外键
- [x] 支持级联规则配置
- [x] 编辑表时可添加/删除外键

### M12 侧边栏表列表 ✅
- [x] 显示表列表
- [x] 支持搜索过滤
- [x] 快速切换表
- [x] 当前表高亮显示

### M13 JSON 单元格编辑器 ✅
- [x] JSON 语法高亮
- [x] 自动格式化
- [x] 语法验证
- [x] 弹窗编辑器

### M14 记录详情表单 ✅
- [x] 弹窗表单编辑
- [x] 字段类型适配
- [x] 外键下拉选择
- [x] 表单验证

### M17 Authentication 管理界面 ✅
- [x] OAuth 提供商配置
- [x] 项目用户列表
- [x] 用户详情/禁用

### M18 Storage 管理界面 ✅
- [x] Buckets 管理
- [x] 文件上传/下载/删除
- [x] 公开/私有访问控制

### M19 Edge Functions ✅
- [x] Deno Worker 容器
- [x] 函数创建/编辑/部署
- [x] Secrets 管理
- [x] 函数调用

### M20 Realtime 管理界面 ✅
- [x] 订阅管理
- [x] 事件日志
- [x] 测试订阅

### M5 API 测试工具 (待开发)
- [ ] GraphQL Playground
- [ ] REST 测试客户端

### M6 数据生成器 (待开发)
- [ ] Faker 测试数据生成
- [ ] 字段类型智能映射

### M16 MCP 集成 (待开发)
- [ ] 实现 MCP Server
- [ ] 支持表操作工具
- [ ] 支持数据查询工具

---

**创建日期**: 2026-03-02
**更新日期**: 2026-03-07
**状态**: Phase 1-4 已完成，Phase 5 待开发
