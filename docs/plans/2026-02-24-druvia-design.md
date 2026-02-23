# Druvia - Schema 级隔离 BaaS 平台设计文档

> 创建日期: 2026-02-24
> 基于: 2026-02-23-drubase-v2-design.md
> 状态: 已批准

## 一、项目目标

构建类 Supabase 的自托管 BaaS 平台，实现：
- **Schema 级隔离**：每个租户拥有独立 PostgreSQL Schema
- **完整数据库能力**：表/函数/视图/物化视图 per schema
- **Headless 架构**：Node.js API + Next.js 管理界面
- **可插拔适配器**：Storage/Auth 支持多后端切换
- **Supabase 级体验**：开发者友好的 API 和管理界面
- **产品化潜力**：可商业化分发

---

## 二、技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Druvia Admin (Next.js 16)                    │
│  Studio Admin 模板 + React 19.2 + Tailwind 4 + shadcn/ui (2026) │
└─────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────┐
│              Druvia Management Layer (Node.js 22 LTS)            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Adapters Layer (可插拔)                   ││
│  │  ┌─────────────────────┐  ┌─────────────────────┐           ││
│  │  │   Storage Adapters  │  │    Auth Adapters    │           ││
│  │  │  R2 | Local | S3    │  │  微信|钉钉|飞书|OIDC │           ││
│  │  └─────────────────────┘  └─────────────────────┘           ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐        │
│  │ 租户管理   │ │ Schema管理│ │ Backup    │ │ 限流/缓存 │        │
│  │ Fastify 5 │ │ DDL 生成  │ │ 服务      │ │ Redis 7   │        │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘        │
└─────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────┐
│                      Hasura CE 2.40+                             │
│  GraphQL/REST API | Subscriptions | Actions | 权限控制           │
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
| **文件存储** | Cloudflare R2 / Local | - | - |
| **前端框架** | Next.js | 16.x | MIT |
| **UI 框架** | React | 19.2.1 | MIT |
| **样式** | Tailwind CSS | 4.x | MIT |
| **UI 组件** | shadcn/ui | 2026.02 | MIT |
| **语言** | TypeScript | 5.x | Apache 2.0 |
| **包管理** | pnpm | 最新 | MIT |

---

## 四、多租户架构

### 4.1 隔离模式

采用 **Schema-per-Tenant** 模式：

```
PostgreSQL 结构：
├── public (Druvia 核心)
│   ├── druvia_tenants              # 租户注册表
│   ├── druvia_projects             # 项目注册表
│   ├── druvia_users                # 平台用户
│   ├── druvia_schema_registry      # Schema 元数据
│   ├── druvia_backups              # 备份记录
│   ├── druvia_files                # 文件元数据
│   ├── druvia_tenant_auth_providers    # 租户认证配置
│   ├── druvia_tenant_storage_config    # 租户存储配置
│   └── druvia_user_providers       # 第三方账号绑定
│
├── tenant_acme (租户 A)
│   ├── _meta_tables                # 表元数据
│   ├── _meta_functions             # 函数元数据
│   ├── _meta_views                 # 视图元数据
│   ├── users                       # 业务表
│   ├── orders                      # 业务表
│   └── calculate_totals()          # 自定义函数
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
| **认证服务** | JWT、API Key、第三方登录 | Node.js + Auth Adapters |
| **Storage 服务** | 文件上传/管理 | Node.js + Storage Adapters |
| **Backup 服务** | 备份/恢复 | Node.js + pg_dump |
| **限流** | 租户级、项目级 | Node.js + Redis |
| **缓存** | 响应缓存 | Redis |
| **API 层** | GraphQL/REST | Hasura 自动生成 |
| **实时订阅** | WebSocket | Hasura Subscriptions |
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
| **文件浏览器** | 文件上传、管理、预览 |
| **备份管理** | 备份列表、创建、恢复、下载 |
| **SQL 编辑器** | 自定义查询、结果展示 |
| **API 文档** | 自动生成、Swagger UI |
| **用户管理** | 成员、角色、权限 |
| **认证配置** | 第三方登录配置 |
| **设置** | 租户/项目配置、API Key、存储配置 |

---

## 六、关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| **Storage 后端** | Cloudflare R2 + Local 兜底 | R2 无出口费用，Local 保证可用性 |
| **权限控制** | Hasura 权限（不用 PostgreSQL RLS） | BaaS 场景所有访问都通过 API |
| **自定义函数** | PostgreSQL Functions + Hasura Actions | 不支持用户上传代码，简化架构 |
| **第三方认证** | 可插拔 Auth Adapters | 支持微信/钉钉/飞书/OIDC 扩展 |
| **实时订阅** | Hasura Subscriptions | 替代 Supabase Realtime |
| **备份恢复** | 手动触发 + pg_dump | 租户级备份/恢复 |

---

详细设计见附属文档：
- [Adapters 层设计](./2026-02-24-druvia-adapters.md)
- [数据库设计](./2026-02-24-druvia-database.md)
- [API 设计](./2026-02-24-druvia-api.md)
- [项目结构与部署](./2026-02-24-druvia-structure.md)
