# Phase 5 P1 功能设计文档

## 概述

Phase 5 P1 包含三个模块，聚焦数据导入和 API 开发体验：

| 模块 | 功能 | 技术方案 |
|------|------|----------|
| M4-CSV | CSV 导入 | papaparse + 自研映射 UI |
| M5 | API 测试工具 | GraphiQL + Scalar API Client |
| M9 | API 文档生成 | 自研生成 + Scalar Reference |

**创建日期**: 2026-03-06
**状态**: 已批准
**审核日期**: 2026-03-06

---

> **Review Notes:**
> - API 路径已统一为 `/api/v1/schemas/:schemaName/tables/:tableName/import`
> - 需从项目设置获取 Hasura 凭证（TODO）
> - 权限校验使用 `checkProjectAccess`（位于 `apps/api/src/lib/access.ts`）

---

## M4-CSV: CSV 导入

### 页面位置

`/t/[tenantId]/p/[projectId]/tables/[tableName]/data` → 工具栏「导入 CSV」按钮

### 用户流程

```
1. 点击「导入 CSV」→ 打开导入对话框
2. 拖拽或选择 CSV 文件
3. 预览前 10 行数据
4. 配置列映射（CSV 列 → 表字段）
5. 设置导入选项（跳过错误行 / 中断）
6. 点击「开始导入」
7. 显示进度和结果
```

### 组件结构

```
apps/admin/src/components/data/
├── CsvImportDialog.tsx      # 主对话框
├── CsvPreviewTable.tsx      # 预览表格
├── CsvColumnMapper.tsx      # 列映射配置
└── CsvImportProgress.tsx    # 导入进度
```

### 技术依赖

| 包 | 版本 | 用途 |
|---|------|------|
| papaparse | ^5.4.1 | CSV 解析 |
| @types/papaparse | ^5.3.14 | 类型定义 |

### API 设计

```typescript
// POST /api/v1/schemas/:schemaName/tables/:tableName/import
// Content-Type: application/json

// Request
{
  rows: Array<Record<string, unknown>>,  // 解析后的数据
  options: {
    onError: 'skip' | 'abort',           // 错误处理策略
    batchSize: 100                        // 批量插入大小
  }
}

// Response
{
  success: true,
  imported: 950,
  skipped: 50,
  errors: [{ row: 5, error: 'Invalid UUID' }]
}
```

### 列映射逻辑

1. **自动匹配**：CSV 列名与表字段名相同（忽略大小写、下划线）
2. **手动调整**：下拉选择目标字段
3. **跳过列**：不导入某些 CSV 列
4. **类型转换**：
   - 字符串 → 数字：`parseInt` / `parseFloat`
   - 字符串 → 布尔：`true/false/1/0`
   - 字符串 → 日期：ISO 8601 解析
   - 空字符串 → `null`（nullable 字段）

### 错误处理

| 错误类型 | 处理方式 |
|----------|----------|
| 类型转换失败 | 根据 onError 策略跳过或中断 |
| 唯一约束冲突 | 记录错误，继续下一行 |
| 外键约束失败 | 记录错误，继续下一行 |
| 文件过大 | 前端限制 10MB，分批上传 |

### 验收标准

- [ ] 可上传 CSV 文件（拖拽 + 点击选择）
- [ ] 正确预览 CSV 数据（前 10 行）
- [ ] 可配置列映射（自动匹配 + 手动调整）
- [ ] 可设置错误处理策略
- [ ] 显示导入进度
- [ ] 显示导入结果（成功/跳过/错误数）
- [ ] 支持中文编码（UTF-8 / GBK 自动检测）

---

## M5: API 测试工具

### 页面位置

`/t/[tenantId]/p/[projectId]/api` → 新页面

### Tab 结构

| Tab | 组件 | 功能 |
|-----|------|------|
| GraphQL | GraphiQL | GraphQL 查询测试 |
| REST | Scalar API Client | REST API 测试 |
| 文档 | Scalar API Reference | API 文档查看 (M9) |

### 组件结构

```
apps/admin/src/app/t/[tenantId]/p/[projectId]/api/
├── page.tsx                    # 主页面（Tab 切换）
├── components/
│   ├── GraphQLPlayground.tsx   # GraphiQL 封装
│   ├── RestClient.tsx          # Scalar API Client 封装
│   └── ApiDocumentation.tsx    # API 文档 (M9)
```

### GraphQL Playground

**技术依赖**：

| 包 | 版本 | 用途 |
|---|------|------|
| @graphiql/react | ^0.37.3 | GraphQL IDE |
| graphql | ^16.9.0 | GraphQL 核心库 |

**功能**：
- 连接项目的 Hasura GraphQL 端点
- 自动注入认证 Header
- Schema 自动补全
- 查询历史（localStorage）

**实现**：

```tsx
// GraphQLPlayground.tsx
import { GraphiQL } from '@graphiql/react';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import '@graphiql/react/dist/style.css';

interface Props {
  hasuraUrl: string;
  adminSecret: string;
}

export function GraphQLPlayground({ hasuraUrl, adminSecret }: Props) {
  const fetcher = createGraphiQLFetcher({
    url: `${hasuraUrl}/v1/graphql`,
    headers: { 'x-hasura-admin-secret': adminSecret }
  });

  return <GraphiQL fetcher={fetcher} />;
}
```

### REST Client

**技术依赖**：

| 包 | 版本 | 用途 |
|---|------|------|
| @scalar/api-client-react | ^1.4.1 | REST API 测试客户端 |

**功能**：
- 发送 HTTP 请求（GET/POST/PUT/PATCH/DELETE）
- 自定义 Headers、Query Params、Body
- 响应预览（JSON 格式化、状态码、耗时）
- 请求历史

**实现**：

```tsx
// RestClient.tsx
import { ApiClientReact } from '@scalar/api-client-react';
import '@scalar/api-client-react/style.css';

interface Props {
  openApiUrl?: string;
}

export function RestClient({ openApiUrl }: Props) {
  return (
    <ApiClientReact
      configuration={{
        spec: openApiUrl ? { url: openApiUrl } : undefined,
        proxyUrl: undefined  // 直接请求，不走代理
      }}
    />
  );
}
```

### 验收标准

- [ ] GraphQL Tab 可执行查询
- [ ] GraphQL 自动补全正常工作
- [ ] REST Tab 可发送各类 HTTP 请求
- [ ] REST 响应正确显示（JSON 格式化）
- [ ] Tab 切换状态保持

---

## M9: API 文档生成

### 页面位置

`/t/[tenantId]/p/[projectId]/api` → 「文档」Tab

### 功能模块

| 功能 | 说明 |
|------|------|
| OpenAPI 文档 | 基于表结构自动生成，Scalar 渲染 |
| GraphQL SDL | 从 Hasura introspection 导出 |
| 下载导出 | JSON / YAML / SDL 文件下载 |

### 后端 API

```typescript
// GET /api/v1/projects/:id/openapi
// 返回 OpenAPI 3.0 JSON

// GET /api/v1/projects/:id/openapi?format=yaml
// 返回 OpenAPI 3.0 YAML

// GET /api/v1/projects/:id/graphql/schema
// 返回 GraphQL SDL 文本
```

### OpenAPI 生成逻辑

基于项目表结构自动生成 OpenAPI 3.0 规范：

```yaml
openapi: 3.0.3
info:
  title: "{projectName} API"
  version: "1.0.0"
  description: "Auto-generated API documentation for {projectName}"

servers:
  - url: "{apiBaseUrl}"

paths:
  /api/v1/schemas/{schemaName}/tables/{tableName}/rows:
    get:
      summary: "List {tableName} rows"
      tags: ["{tableName}"]
      parameters:
        - name: limit
          in: query
          schema: { type: integer, default: 20 }
        - name: offset
          in: query
          schema: { type: integer, default: 0 }
        - name: orderBy
          in: query
          schema: { type: string }
      responses:
        '200':
          description: "List of rows"
          content:
            application/json:
              schema:
                type: object
                properties:
                  rows:
                    type: array
                    items:
                      $ref: '#/components/schemas/{TableName}'
                  total:
                    type: integer

    post:
      summary: "Create {tableName} row"
      tags: ["{tableName}"]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/{TableName}Input'
      responses:
        '201':
          description: "Created"

components:
  schemas:
    Posts:
      type: object
      properties:
        id:
          type: string
          format: uuid
        title:
          type: string
        content:
          type: string
        created_at:
          type: string
          format: date-time
```

### 类型映射

| PostgreSQL 类型 | OpenAPI 类型 |
|-----------------|--------------|
| uuid | string (format: uuid) |
| text, varchar | string |
| integer, int4 | integer |
| bigint, int8 | integer (format: int64) |
| numeric, decimal | number |
| boolean | boolean |
| timestamp, timestamptz | string (format: date-time) |
| date | string (format: date) |
| jsonb, json | object |
| array | array |

### 后端实现

```
apps/api/src/modules/openapi/
├── openapi.service.ts       # OpenAPI JSON 生成服务
├── openapi.routes.ts        # API 路由
├── schema-to-openapi.ts     # 表结构转 OpenAPI Schema
└── graphql-schema.service.ts # GraphQL SDL 导出
```

### 前端实现

**技术依赖**：

| 包 | 版本 | 用途 |
|---|------|------|
| @scalar/api-reference-react | ^0.9.1 | API 文档渲染 |

```tsx
// ApiDocumentation.tsx
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

interface Props {
  projectId: string;
}

export function ApiDocumentation({ projectId }: Props) {
  return (
    <div className="h-full">
      <ApiReferenceReact
        configuration={{
          spec: { url: `/api/v1/projects/${projectId}/openapi` },
          theme: 'default'
        }}
      />
    </div>
  );
}
```

### GraphQL SDL 导出

```typescript
// graphql-schema.service.ts
import { getIntrospectionQuery, buildClientSchema, printSchema } from 'graphql';

export async function getGraphQLSchema(hasuraUrl: string, adminSecret: string) {
  const response = await fetch(`${hasuraUrl}/v1/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': adminSecret
    },
    body: JSON.stringify({ query: getIntrospectionQuery() })
  });

  const { data } = await response.json();
  const schema = buildClientSchema(data);
  return printSchema(schema);
}
```

### 验收标准

- [ ] OpenAPI 文档正确生成（基于表结构）
- [ ] Scalar 文档渲染正常
- [ ] 可下载 OpenAPI JSON/YAML
- [ ] GraphQL SDL 正确导出
- [ ] 可下载 GraphQL SDL 文件
- [ ] 文档实时反映表结构变更

---

## 技术栈汇总

### 新增依赖

| 包 | 版本 | 大小 | 用途 |
|---|------|------|------|
| papaparse | ^5.4.1 | ~47KB | CSV 解析 |
| @types/papaparse | ^5.3.14 | - | 类型定义 |
| @graphiql/react | ^0.37.3 | ~300KB | GraphQL IDE |
| @graphiql/toolkit | ^0.11.0 | ~50KB | GraphiQL 工具 |
| graphql | ^16.9.0 | ~180KB | GraphQL 核心 |
| @scalar/api-client-react | ^1.4.1 | ~280KB | REST Client |
| @scalar/api-reference-react | ^0.9.1 | ~370KB | API 文档 |

### 文件结构

```
apps/admin/src/
├── app/t/[tenantId]/p/[projectId]/api/
│   ├── page.tsx
│   └── components/
│       ├── GraphQLPlayground.tsx
│       ├── RestClient.tsx
│       └── ApiDocumentation.tsx
├── components/data/
│   ├── CsvImportDialog.tsx
│   ├── CsvPreviewTable.tsx
│   ├── CsvColumnMapper.tsx
│   └── CsvImportProgress.tsx

apps/api/src/modules/
├── openapi/
│   ├── openapi.service.ts
│   ├── openapi.routes.ts
│   ├── schema-to-openapi.ts
│   └── graphql-schema.service.ts
├── table/
│   └── table.routes.ts  # 新增 import 端点
```

---

## 实施顺序

1. **M4-CSV**：CSV 导入（独立功能，无依赖）
2. **M9**：API 文档生成（后端先行，为 M5 提供 OpenAPI）
3. **M5**：API 测试工具（依赖 M9 的 OpenAPI 端点）

---

**更新日期**: 2026-03-06
**审核状态**: 已批准
