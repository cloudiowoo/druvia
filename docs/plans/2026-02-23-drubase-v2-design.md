# Drubase v2 - Schema 级隔离 BaaS 平台设计文档

> 创建日期: 2026-02-23
> 状态: 已批准

## 一、项目目标

构建类 Supabase 的自托管 BaaS 平台，实现：
- **Schema 级隔离**：每个租户拥有独立 PostgreSQL Schema
- **完整数据库能力**：表/函数/视图/物化视图 per schema
- **Headless 架构**：Drupal 弃用，Node.js API + Next.js 管理界面
- **Supabase 级体验**：开发者友好的 API 和管理界面
- **产品化潜力**：可商业化分发

---

## 二、技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Drubase Admin (Next.js 16)                   │
│  Studio Admin 模板 + React 19.2 + Tailwind 4 + shadcn/ui (2026) │
└─────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────┐
│              Drubase Management Layer (Node.js 22 LTS)           │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐        │
│  │ 租户管理   │ │ Schema管理│ │ 认证服务   │ │ 限流/缓存 │        │
│  │ Fastify 5 │ │ DDL 生成  │ │ JWT/APIKey│ │ Redis 7   │        │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘        │
└─────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────┐
│                      Hasura CE 2.40+                             │
│  GraphQL/REST API | 实时订阅 | 权限控制 | PostgreSQL 函数调用    │
└─────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────┐
│                       PostgreSQL 17                              │
│  public | tenant_acme | tenant_beta | tenant_gamma | ...        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、技术栈

| 层级 | 技术选型 | 版本 | 许可证 |
|------|---------|------|--------|
| **数据库** | PostgreSQL | 17.x | PostgreSQL License |
| **API 引擎** | Hasura CE | 2.40+ | Apache 2.0 |
| **管理层** | Node.js + Fastify | 22 LTS + 5.x | MIT |
| **缓存/限流** | Redis | 7.x | BSD |
| **前端框架** | Next.js | 16.x | MIT |
| **UI 框架** | React | 19.2.1 | MIT |
| **样式** | Tailwind CSS | 4.x | MIT |
| **UI 组件** | shadcn/ui | 2026.02 | MIT |
| **模板基础** | Studio Admin | 最新 | - |
| **语言** | TypeScript | 5.x | Apache 2.0 |
| **包管理** | pnpm | 最新 | MIT |

---

## 四、多租户架构

### 4.1 隔离模式

采用 **Schema-per-Tenant** 模式：

```
PostgreSQL 结构：
├── public (Drubase 核心)
│   ├── drubase_tenants          # 租户注册表
│   ├── drubase_projects         # 项目注册表
│   ├── drubase_users            # 平台用户
│   └── drubase_schema_registry  # Schema 元数据
│
├── tenant_acme (租户 A)
│   ├── _meta_tables             # 表元数据
│   ├── _meta_functions          # 函数元数据
│   ├── _meta_views              # 视图元数据
│   ├── users                    # 业务表
│   ├── orders                   # 业务表
│   └── calculate_totals()       # 自定义函数
│
└── tenant_beta (租户 B)
    └── ...
```

### 4.2 Schema 命名规则

```
租户级：tenant_{alias}
项目级：tenant_{alias}_proj_{project_alias}

示例：
- tenant_acme
- tenant_acme_proj_shop
- tenant_acme_proj_blog
```

---

## 五、核心功能模块

### 5.1 后端模块

| 模块 | 功能 | 实现方式 |
|------|------|---------|
| **租户管理** | CRUD、配置、统计 | Node.js 自建 |
| **Schema 管理** | CREATE/DROP SCHEMA | Node.js 自建 |
| **表管理** | DDL 生成、元数据同步 | Node.js 自建 |
| **函数管理** | CREATE FUNCTION、Hasura Track | Node.js + Hasura |
| **视图管理** | 视图/物化视图、刷新 | Node.js + Hasura |
| **认证服务** | JWT、API Key、多租户 | Node.js 自建 |
| **限流** | 租户级、项目级 | Node.js + Redis |
| **缓存** | 响应缓存 | Redis |
| **API 层** | GraphQL/REST | Hasura 自动生成 |
| **实时订阅** | WebSocket | Hasura 内置 |
| **RPC 调用** | PostgreSQL 函数 | Hasura Track |

### 5.2 前端页面

| 页面 | 功能 |
|------|------|
| **仪表板** | 概览统计、活动日志、使用图表 |
| **租户管理** | 租户列表、创建、设置 |
| **项目管理** | 项目列表、创建、配置 |
| **Schema 设计器** | 可视化表设计、DDL 预览 |
| **数据浏览器** | 数据查看、编辑、过滤、导出 |
| **函数管理** | 函数列表、创建、测试 |
| **视图管理** | 视图列表、创建、刷新 |
| **SQL 编辑器** | 自定义查询、结果展示 |
| **API 文档** | 自动生成、Swagger UI |
| **用户管理** | 成员、角色、权限 |
| **设置** | 租户/项目配置、API Key |

---

## 六、数据库设计

### 6.1 核心表 (public schema)

```sql
-- 租户表
CREATE TABLE drubase_tenants (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL,
  alias VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  owner_uid INT NOT NULL,
  plan VARCHAR(20) DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 项目表
CREATE TABLE drubase_projects (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES drubase_tenants(tenant_id),
  alias VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  schema_name VARCHAR(128),
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, alias)
);

-- Schema 注册表
CREATE TABLE drubase_schema_registry (
  id SERIAL PRIMARY KEY,
  schema_name VARCHAR(128) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64),
  schema_type VARCHAR(20) NOT NULL,
  table_count INT DEFAULT 0,
  function_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 6.2 租户 Schema 元数据表

```sql
-- 每个租户 Schema 内的元数据表

-- 表元数据
CREATE TABLE _meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  columns JSONB NOT NULL,
  indexes JSONB DEFAULT '[]',
  constraints JSONB DEFAULT '[]',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 函数元数据
CREATE TABLE _meta_functions (
  id SERIAL PRIMARY KEY,
  function_name VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  parameters JSONB DEFAULT '[]',
  return_type VARCHAR(64),
  language VARCHAR(20) DEFAULT 'plpgsql',
  definition TEXT NOT NULL,
  is_public BOOLEAN DEFAULT false,
  timeout_ms INT DEFAULT 5000,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 视图元数据
CREATE TABLE _meta_views (
  id SERIAL PRIMARY KEY,
  view_name VARCHAR(128) UNIQUE NOT NULL,
  view_type VARCHAR(20) NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  definition TEXT NOT NULL,
  columns JSONB,
  refresh_schedule VARCHAR(64),
  last_refreshed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## 七、API 设计

### 7.1 认证 API

```
POST   /api/auth/login              # 登录
POST   /api/auth/register           # 注册
POST   /api/auth/refresh            # 刷新 Token
POST   /api/auth/logout             # 登出
```

### 7.2 租户管理 API

```
POST   /api/tenants                 # 创建租户
GET    /api/tenants                 # 租户列表
GET    /api/tenants/:id             # 租户详情
PUT    /api/tenants/:id             # 更新租户
DELETE /api/tenants/:id             # 删除租户
```

### 7.3 项目管理 API

```
POST   /api/tenants/:tenantId/projects      # 创建项目
GET    /api/tenants/:tenantId/projects      # 项目列表
GET    /api/projects/:projectId             # 项目详情
PUT    /api/projects/:projectId             # 更新项目
DELETE /api/projects/:projectId             # 删除项目
```

### 7.4 Schema 管理 API

```
POST   /api/projects/:projectId/tables              # 创建表
GET    /api/projects/:projectId/tables              # 表列表
GET    /api/projects/:projectId/tables/:name        # 表结构
PUT    /api/projects/:projectId/tables/:name        # 修改表
DELETE /api/projects/:projectId/tables/:name        # 删除表

POST   /api/projects/:projectId/functions           # 创建函数
GET    /api/projects/:projectId/functions           # 函数列表
DELETE /api/projects/:projectId/functions/:name     # 删除函数

POST   /api/projects/:projectId/views               # 创建视图
GET    /api/projects/:projectId/views               # 视图列表
POST   /api/projects/:projectId/views/:name/refresh # 刷新物化视图
DELETE /api/projects/:projectId/views/:name         # 删除视图
```

### 7.5 数据操作 API (Hasura 代理)

```
POST   /api/projects/:projectId/graphql             # GraphQL 端点
GET    /api/projects/:projectId/rest/:table         # REST 查询
POST   /api/projects/:projectId/rest/:table         # REST 插入
PUT    /api/projects/:projectId/rest/:table/:id     # REST 更新
DELETE /api/projects/:projectId/rest/:table/:id     # REST 删除
POST   /api/projects/:projectId/rpc/:function       # RPC 调用
```

---

## 八、项目结构

```
drubase-v2/
├── apps/
│   ├── api/                          # Node.js 管理层
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── tenant/           # 租户管理
│   │   │   │   ├── project/          # 项目管理
│   │   │   │   ├── schema/           # Schema 管理
│   │   │   │   │   ├── table.ts
│   │   │   │   │   ├── function.ts
│   │   │   │   │   └── view.ts
│   │   │   │   ├── auth/             # 认证服务
│   │   │   │   └── proxy/            # Hasura 代理
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT 验证
│   │   │   │   ├── rateLimit.ts      # 限流
│   │   │   │   ├── cache.ts          # 缓存
│   │   │   │   └── tenant.ts         # 租户上下文
│   │   │   ├── lib/
│   │   │   │   ├── db.ts             # PostgreSQL 连接
│   │   │   │   ├── redis.ts          # Redis 连接
│   │   │   │   ├── hasura.ts         # Hasura 客户端
│   │   │   │   └── ddl.ts            # DDL 生成器
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── admin/                        # Next.js 管理界面
│       ├── src/
│       │   ├── app/                  # App Router
│       │   │   ├── (auth)/
│       │   │   │   ├── login/
│       │   │   │   └── register/
│       │   │   ├── (dashboard)/
│       │   │   │   ├── layout.tsx
│       │   │   │   ├── page.tsx
│       │   │   │   ├── tenants/
│       │   │   │   ├── projects/
│       │   │   │   │   └── [id]/
│       │   │   │   │       ├── tables/
│       │   │   │   │       ├── data/
│       │   │   │   │       ├── functions/
│       │   │   │   │       ├── views/
│       │   │   │   │       └── settings/
│       │   │   │   └── settings/
│       │   │   └── layout.tsx
│       │   ├── components/
│       │   │   ├── ui/               # shadcn/ui
│       │   │   ├── layout/
│       │   │   ├── tables/
│       │   │   ├── forms/
│       │   │   └── charts/
│       │   ├── lib/
│       │   │   ├── api/              # API 客户端
│       │   │   ├── auth/
│       │   │   └── utils/
│       │   └── hooks/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tailwind.config.ts
│       └── Dockerfile
│
├── packages/
│   └── shared/                       # 共享类型/工具
│       ├── src/
│       │   ├── types/
│       │   └── utils/
│       └── package.json
│
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── hasura/
│       └── metadata/
│
├── docs/
│   └── plans/
│
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

## 九、开发计划

| 阶段 | 内容 | 周期 |
|------|------|------|
| **Phase 1** | 基础架构 (租户/Schema/认证) | 2 周 |
| **Phase 2** | 表管理 + 数据 API | 2 周 |
| **Phase 3** | 函数/视图管理 | 1.5 周 |
| **Phase 4** | 限流/缓存/安全 | 1 周 |
| **Phase 5** | Admin 界面核心页面 | 3 周 |
| **Phase 6** | 高级功能 (SQL 编辑器等) | 1.5 周 |
| **Phase 7** | 测试/文档/部署 | 1 周 |
| **总计** | | **12 周** |

---

## 十、部署配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: drubase
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: drubase
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  hasura:
    image: hasura/graphql-engine:v2.40.0
    depends_on:
      - postgres
    environment:
      HASURA_GRAPHQL_DATABASE_URL: postgres://drubase:${POSTGRES_PASSWORD}@postgres:5432/drubase
      HASURA_GRAPHQL_ADMIN_SECRET: ${HASURA_ADMIN_SECRET}
      HASURA_GRAPHQL_ENABLE_CONSOLE: "false"
      HASURA_GRAPHQL_JWT_SECRET: '{"type":"HS256","key":"${JWT_SECRET}"}'
    ports:
      - "8080:8080"

  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile
    depends_on:
      - hasura
      - redis
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://drubase:${POSTGRES_PASSWORD}@postgres:5432/drubase
      HASURA_ENDPOINT: http://hasura:8080
      HASURA_ADMIN_SECRET: ${HASURA_ADMIN_SECRET}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
    ports:
      - "3001:3001"

  admin:
    build:
      context: ./apps/admin
      dockerfile: Dockerfile
    depends_on:
      - api
    environment:
      NEXT_PUBLIC_API_URL: http://api:3001
    ports:
      - "3000:3000"

volumes:
  postgres_data:
```

---

## 十一、许可证策略

| 组件 | 许可证 | 商业使用 |
|------|--------|---------|
| Hasura CE | Apache 2.0 | ✅ 允许 |
| PostgreSQL | PostgreSQL License | ✅ 允许 |
| Node.js | MIT | ✅ 允许 |
| Next.js | MIT | ✅ 允许 |
| shadcn/ui | MIT | ✅ 允许 |
| **Drubase 自有代码** | 自定义 | 完全自主 |

所有依赖组件均为商业友好许可证，Drubase 可自由商业化。

---

## 十二、风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| Hasura 依赖 | 低 | 中 | Apache 2.0 可 fork |
| Schema 数量过多 | 中 | 中 | 监控 + 清理策略 |
| 性能瓶颈 | 中 | 中 | Redis 缓存 + 连接池 |
| 安全风险 | 低 | 高 | JWT + 限流 + 审计 |
| 许可证变更 | 极低 | 中 | 可 fork 当前版本 |

---

## 十三、验收标准

### 功能验收

- [ ] 租户创建后自动创建 Schema
- [ ] 可视化创建表并生成正确 DDL
- [ ] 数据 CRUD 通过 Hasura API 正常工作
- [ ] PostgreSQL 函数可创建并通过 RPC 调用
- [ ] 物化视图可创建并刷新
- [ ] JWT 认证正常工作
- [ ] 租户级限流生效
- [ ] 管理界面所有页面可用

### 性能验收

- [ ] API 响应时间 < 100ms (P95)
- [ ] 支持 1000+ 并发连接
- [ ] Schema 创建时间 < 5s

---

## 十四、参考资料

- [Hasura GraphQL Engine](https://hasura.io/docs/)
- [PostgreSQL 17 Documentation](https://www.postgresql.org/docs/17/)
- [Next.js 16 Documentation](https://nextjs.org/docs)
- [shadcn/ui Components](https://ui.shadcn.com/)
- [Supabase Architecture](https://supabase.com/docs/guides/getting-started/architecture)
