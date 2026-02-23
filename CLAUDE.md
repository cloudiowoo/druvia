# Druvia - Schema 级隔离 BaaS 平台

自托管 Backend-as-a-Service 平台，类 Supabase 架构。

**Stack**: Node.js 22 LTS + Fastify 5 + PostgreSQL 17 + Hasura CE 2.40 + Redis 7
**Architecture**: Schema-per-Tenant 多租户隔离

---

## Quick Start

```bash
# 1. 启动环境
cd docker && docker-compose up -d

# 2. 安装依赖
pnpm install

# 3. 启动开发服务
pnpm dev

# 4. 验证
curl http://localhost:3001/health
curl http://localhost:8080/healthz  # Hasura
```

---

## 核心开发约束

### TypeScript 标准

```typescript
// ✅ 正确: 使用严格类型
import type { Tenant } from '@druvia/shared';

export async function getTenant(id: string): Promise<Tenant | null> {
  return queryOne<Tenant>('SELECT * FROM druvia_tenants WHERE tenant_id = $1', [id]);
}

// ❌ 禁止: any 类型
function getData(input: any): any { ... }
```

### API 响应格式

```typescript
// 成功
return reply.send({
  success: true,
  data: result,
});

// 错误
return reply.status(404).send({
  success: false,
  error: { code: 'NOT_FOUND', message: 'Resource not found' },
});
```

### 适配器模式

所有外部服务使用可插拔适配器：

```typescript
// Storage: R2 / Local / S3
const storage = createStorageAdapter(config);
await storage.upload(file, path);

// Auth: WeChat / DingTalk / Feishu / OIDC
const auth = createAuthAdapter('wechat', config);
const result = await auth.exchangeCode(code);
```

---

## Docker 服务

| 服务 | 容器 | 端口 |
|------|------|------|
| API | `druvia-api` | 3001 |
| Admin | `druvia-admin` | 3000 |
| Hasura | `hasura` | 8080 |
| Database | `postgres` | 5432 |
| Cache | `redis` | 6379 |

### 数据库访问

```bash
# 直接访问
docker exec -it postgres psql -U druvia -d druvia

# 查看租户 Schema
\dn tenant_*
```

---

## 数据库 Schema

### 核心表 (public)

- `druvia_tenants`: 租户注册表
- `druvia_projects`: 项目注册表
- `druvia_users`: 平台用户
- `druvia_schema_registry`: Schema 元数据
- `druvia_backups`: 备份记录
- `druvia_files`: 文件元数据
- `druvia_tenant_auth_providers`: 租户认证配置
- `druvia_tenant_storage_config`: 租户存储配置

### 租户 Schema

```
tenant_{alias}/
├── _meta_tables      # 表元数据
├── _meta_functions   # 函数元数据
├── _meta_views       # 视图元数据
└── [业务表...]
```

---

## 项目结构

```
druvia/
├── apps/
│   ├── api/          # Node.js 管理层 (Fastify)
│   │   ├── src/
│   │   │   ├── adapters/     # Storage/Auth 适配器
│   │   │   ├── modules/      # 业务模块
│   │   │   ├── middleware/   # 中间件
│   │   │   └── lib/          # 工具库
│   │   └── Dockerfile
│   └── admin/        # Next.js 管理界面
├── packages/
│   └── shared/       # 共享类型/工具
├── docker/
│   └── docker-compose.yml
├── migrations/       # 数据库迁移
└── docs/plans/       # 设计文档
```

---

## 开发规则

1. **使用 TypeScript 严格模式** - 禁止 any 类型
2. **遵循适配器模式** - Storage/Auth 必须通过适配器
3. **Schema 隔离** - 租户数据必须在独立 Schema
4. **Hasura 权限** - 使用 Hasura 权限控制，不用 PostgreSQL RLS
5. **TDD 开发** - 先写测试，再写实现

---

## 领域知识（Skills）

详细指南按需加载，触发词激活：

| Skill | 触发词 | 内容 |
|-------|--------|------|
| docker-guide | docker, 容器, compose | Docker 环境配置 |
| api-guide | API, 响应格式, 限流 | API 开发模式 |
| database-guide | Schema, 租户表, 迁移 | 数据库设计 |
| adapters-guide | Storage, Auth, R2, 微信 | 适配器开发 |
| hasura-guide | GraphQL, Subscriptions, Actions | Hasura 配置 |

---

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm dev` | 启动开发服务 |
| `pnpm build` | 构建项目 |
| `pnpm test` | 运行测试 |
| `/commit` | 生成 Git 提交信息 |

---

## 紧急调试

```bash
# 检查服务
docker-compose ps

# 查看日志
docker-compose logs api
docker-compose logs hasura

# 完全重置
docker-compose down -v && docker-compose up -d
```

---

**Last Updated**: 2026-02-24
**Architecture**: 三级渐进式披露（元数据 → CLAUDE.md → Skills）
