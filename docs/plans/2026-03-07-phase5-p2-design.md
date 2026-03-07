# Phase 5 P2 功能设计文档

## 概述

Phase 5 P2 包含五个模块，聚焦开发体验优化和架构简化：

| 模块 | 功能 | 技术方案 |
|------|------|----------|
| M6 | 数据生成器 | @faker-js/faker + 动态导入 |
| M15 | 表单验证增强 | zod + react-hook-form |
| M21 | 单租户模式重构 | 环境变量开关 + 路由重定向 |
| M16 | MCP 集成 | @druvia/mcp 独立包 |
| M10 | 环境管理 | Schema 后缀隔离 |

**创建日期**: 2026-03-07
**状态**: 已审核

---

## M6: 数据生成器

### 页面位置

`/t/[tenantId]/p/[projectId]/tables/[tableName]/data` → 工具栏「生成测试数据」按钮

### 用户流程

```
1. 点击「生成测试数据」→ 打开对话框
2. 设置生成数量（默认 10，最大 100）
3. 预览字段映射规则（自动推断 + 可调整）
4. 点击「生成」→ 预览数据
5. 确认后批量插入
```

### 组件结构

```
apps/admin/src/components/data/
└── DataGeneratorDialog.tsx    # 主对话框（含预览、规则配置）
```

### 字段类型 → Faker 映射

| 字段名/类型 | Faker 方法 |
|------------|-----------|
| email | `faker.internet.email()` |
| username/name | `faker.person.fullName()` |
| title | `faker.lorem.sentence()` |
| content/text/description | `faker.lorem.paragraphs(1)` |
| integer/int | `faker.number.int({ min: 1, max: 1000 })` |
| boolean | `faker.datatype.boolean()` |
| uuid | `faker.string.uuid()` |
| timestamp/date | `faker.date.recent()` |
| url | `faker.internet.url()` |
| phone | `faker.phone.number()` |

### 技术实现

- 动态导入 `@faker-js/faker` 减少初始包大小
- 前端生成预览数据，复用现有批量插入 API
- 外键字段处理：
  1. 检测字段是否有外键约束
  2. 调用 `GET /schemas/:schema/tables/:table/rows?limit=100` 获取关联表数据
  3. 从返回的 ID 列表中随机选择

### 验收标准

- [ ] 可设置生成数量（10-100）
- [ ] 自动推断字段类型并映射 Faker 方法
- [ ] 可手动调整字段生成规则
- [ ] 预览生成数据
- [ ] 批量插入成功

---

## M15: 表单验证增强

### 目标

创建共享 zod schema 库，逐步应用到关键表单组件。

### 共享 Schema 定义

> 注意：项目使用 zod v4，语法与 v3 兼容

```typescript
// apps/admin/src/lib/schemas/index.ts
import { z } from 'zod';

// 列名验证：小写字母开头，只含字母数字下划线
export const columnNameSchema = z.string()
  .min(1, '列名不能为空')
  .max(63, '列名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '列名只能包含小写字母、数字和下划线');

// 表名验证
export const tableNameSchema = z.string()
  .min(1, '表名不能为空')
  .max(63, '表名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '表名只能包含小写字母、数字和下划线');

// 项目名验证
export const projectNameSchema = z.string()
  .min(1, '项目名不能为空')
  .max(100, '项目名最长 100 字符');
```

### 重构范围（优先级排序）

| 组件 | 当前状态 | 重构内容 |
|------|---------|---------|
| CreateTableDialog | 部分验证 | 添加 zod schema |
| EditTableDialog | 部分验证 | 添加 zod schema |
| RecordFormDialog | 已用 react-hook-form | 增强类型验证 |
| CreateProjectDialog | 基础验证 | 添加 zod schema |

### 实现策略

- 渐进式：不破坏现有功能，逐个组件迁移
- 已有 `@hookform/resolvers` 依赖，直接使用 `zodResolver`

### 验收标准

- [ ] 创建共享 schema 库
- [ ] CreateTableDialog 使用 zod 验证
- [ ] EditTableDialog 使用 zod 验证
- [ ] 验证错误信息友好显示

---

## M21: 单租户模式重构

### 核心变更

将现有「多租户 → 多项目」模式简化为「默认单租户 → 多项目」，保留多租户逻辑结构。

### 环境变量

```bash
# .env.local (Next.js 客户端需要 NEXT_PUBLIC_ 前缀)
NEXT_PUBLIC_MULTI_TENANT_ENABLED=false  # 默认关闭多租户
NEXT_PUBLIC_DEFAULT_TENANT_ID=default   # 默认租户 ID
```

### 路由行为

| 场景 | MULTI_TENANT_ENABLED=false | MULTI_TENANT_ENABLED=true |
|------|---------------------------|--------------------------|
| 登录后跳转 | `/t/default/dashboard` | `/tenants`（租户选择页） |
| 租户选择器 | 隐藏 | 显示 |
| URL 结构 | `/t/default/p/[projectId]/...` | `/t/[tenantId]/p/[projectId]/...` |

### 前端改动

| 文件 | 改动 |
|------|------|
| `middleware.ts` | 登录后根据配置重定向到默认租户 |
| `DashboardLayout.tsx` | 条件隐藏租户选择器/切换器 |
| `useAppStore.ts` | 单租户模式下自动设置 currentTenant |
| 登录回调 | 跳转到 Dashboard 而非租户选择页 |

### 后端改动

- 无需改动，API 仍接受 tenantId 参数
- 前端固定传 `default` 作为 tenantId

### 数据库

- 后端 migration 脚本自动创建 `default` 租户记录
- 现有数据无需迁移

```sql
-- migrations/xxx_create_default_tenant.sql
INSERT INTO druvia_tenants (tenant_id, name, created_at)
VALUES ('default', 'Default Tenant', NOW())
ON CONFLICT (tenant_id) DO NOTHING;
```

### 验收标准

- [ ] 环境变量控制多租户开关
- [ ] 单租户模式下登录后直接进入 Dashboard
- [ ] 租户选择器在单租户模式下隐藏
- [ ] 多租户模式下行为不变

---

## M16: MCP 集成

### 架构

```
┌─────────────────────────────────────────────────────────┐
│           AI Coding Assistants                          │
│  (Claude Code, Cursor, Windsurf, Cline, Kiro...)       │
└─────────────────────┬───────────────────────────────────┘
                      │ MCP Protocol (stdio)
                      ▼
┌─────────────────────────────────────────────────────────┐
│            @druvia/mcp (npm package)                    │
│  packages/mcp-server/                                   │
│  运行: npx @druvia/mcp                                  │
└─────────────────────┬───────────────────────────────────┘
                      │ REST API (API Key 认证)
                      ▼
┌─────────────────────────────────────────────────────────┐
│               Druvia Backend API                        │
└─────────────────────────────────────────────────────────┘
```

### MCP 工具列表

| 工具 | 说明 | 对应 API |
|------|------|---------|
| `list_tables` | 列出所有表 | GET /schemas/:schema/tables |
| `get_table_schema` | 获取表结构 | GET /schemas/:schema/tables/:table |
| `query_data` | 查询数据 | POST /sql/query |
| `insert_row` | 插入数据 | POST /schemas/:schema/tables/:table/rows |
| `update_row` | 更新数据 | PATCH /schemas/:schema/tables/:table/rows |
| `delete_row` | 删除数据 | DELETE /schemas/:schema/tables/:table/rows |
| `create_table` | 创建表 | POST /schemas/:schema/tables |
| `alter_table` | 修改表结构 | PATCH /schemas/:schema/tables/:table |
| `execute_sql` | 执行 SQL | POST /sql/execute |
| `list_buckets` | 列出存储桶 | GET /storage/buckets |
| `upload_file` | 上传文件 | POST /storage/buckets/:bucket/files |
| `list_files` | 列出文件 | GET /storage/buckets/:bucket/files |

### API Key 管理

新增项目级 API Key 功能：

```
apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/
└── api-keys/page.tsx    # API Key 管理页面
```

| 功能 | 说明 |
|------|------|
| 创建 Key | 生成 `dru_` 前缀的 API Key |
| 查看 Key | 仅创建时显示完整 Key |
| 删除 Key | 立即失效 |
| Key 权限 | 项目级全权限（后期可细化） |

### API Key 数据库设计

```sql
CREATE TABLE druvia_api_keys (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  key_hash VARCHAR(64) NOT NULL,      -- SHA-256 哈希存储，不存明文
  key_prefix VARCHAR(12) NOT NULL,    -- dru_xxxx 用于列表显示
  name VARCHAR(100),                  -- 用户自定义名称
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(key_hash)
);

CREATE INDEX idx_api_keys_project ON druvia_api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON druvia_api_keys(key_hash);
```

**安全说明**：
- API Key 仅在创建时返回完整值，后端只存储 SHA-256 哈希
- 验证时对传入 Key 计算哈希后比对

### 使用方式

```json
// .mcp.json
{
  "mcpServers": {
    "druvia": {
      "command": "npx",
      "args": ["-y", "@druvia/mcp@latest"],
      "env": {
        "DRUVIA_API_KEY": "dru_xxxx",
        "DRUVIA_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

### 包结构

```
packages/mcp-server/
├── package.json
├── src/
│   └── index.ts          # 入口 + MCP Server 实现
└── tsconfig.json
```

> 注：初始版本采用单文件实现，后续可按需拆分为 tools/、api-client.ts 等模块

### 验收标准

- [ ] MCP Server 可通过 npx 运行
- [ ] 支持表数据 CRUD 操作
- [ ] 支持 DDL 操作（创建/修改表）
- [ ] 支持 SQL 执行
- [ ] 支持 Storage 操作
- [ ] API Key 管理界面可用
- [ ] Claude Code 可正常连接使用

---

## M10: 环境管理

### Schema 命名规则

| 环境 | Schema 名 | 示例 |
|------|-----------|------|
| prod (默认) | `dru_{tenant}_{project}` | `dru_default_myapp` |
| dev | `dru_{tenant}_{project}_dev` | `dru_default_myapp_dev` |

### 用户流程

```
1. 新建项目 → 默认创建 prod 环境（无后缀 Schema）
2. 项目设置 → 「环境管理」→ 启用 dev 环境
3. 启用 dev → 克隆 prod Schema 结构（可选克隆数据）
4. 顶部环境切换器 → 切换 dev/prod
5. 所有操作在当前环境 Schema 下执行
```

### 页面位置

```
/t/[tenantId]/p/[projectId]/settings/environments  # 环境管理页
```

### UI 变更

| 位置 | 变更 |
|------|------|
| 项目顶部导航 | 新增环境切换下拉框（dev/prod） |
| 设置页 | 新增「环境管理」Tab |
| 数据页/SQL 页 | 显示当前环境标识 |

### 环境状态持久化

- 使用 URL 参数 `?env=dev` 持久化当前环境选择
- 便于分享链接时保留环境上下文
- 前端 `useAppStore` 同步 URL 参数到全局状态
- 默认值：无参数时为 `prod` 环境

### API 设计

```typescript
// 环境切换通过 query 参数
GET /api/v1/schemas/dru_default_myapp/tables?env=dev
// 实际查询 dru_default_myapp_dev

// 或通过 Header
X-Druvia-Env: dev
```

### 后端改动

| 文件 | 改动 |
|------|------|
| `apps/api/src/lib/schema.ts` | 新增 `resolveSchemaName(base, env)` |
| `apps/api/src/modules/project/` | 新增环境管理 API |
| 各路由 | 读取 env 参数，解析实际 Schema |

### 数据库

```sql
-- druvia_project_environments 表
CREATE TABLE druvia_project_environments (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  env_name VARCHAR(20) NOT NULL,  -- 'dev' | 'prod'
  schema_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, env_name)
);

CREATE INDEX idx_project_environments_project ON druvia_project_environments(project_id);
```

### 验收标准

- [ ] 新建项目默认创建 prod 环境
- [ ] 可启用 dev 环境（克隆 Schema）
- [ ] 环境切换器正常工作
- [ ] 各页面显示当前环境标识
- [ ] API 正确解析环境参数

---

## 技术栈汇总

### 新增依赖

| 包 | 版本 | 用途 |
|---|------|------|
| @faker-js/faker | ^9.0.0 | 测试数据生成 |
| @modelcontextprotocol/sdk | ^1.0.0 | MCP Server |

### 文件结构

```
apps/admin/src/
├── lib/schemas/
│   └── index.ts                    # 共享 zod schema
├── components/data/
│   └── DataGeneratorDialog.tsx     # 数据生成器
├── app/t/[tenantId]/p/[projectId]/settings/
│   ├── api-keys/page.tsx           # API Key 管理
│   └── environments/page.tsx       # 环境管理

packages/mcp-server/                 # MCP Server 独立包
├── package.json
├── src/
│   └── index.ts                    # 入口 + MCP Server 实现
└── tsconfig.json
```

---

## 实施顺序

| 顺序 | 模块 | 依赖 |
|------|------|------|
| 1 | M6: 数据生成器 | 无 |
| 2 | M15: 表单验证增强 | 无 |
| 3 | M21: 单租户模式重构 | 无 |
| 4 | M16: MCP 集成 | 需 API Key 管理 |
| 5 | M10: 环境管理 | 无 |

---

**更新日期**: 2026-03-07
**审核状态**: 已审核
