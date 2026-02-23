# Druvia Phase 1: 基础架构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 搭建 Druvia 项目基础架构，包括 monorepo 结构、数据库初始化、租户管理和基础认证。

**Architecture:** Fastify 5 + PostgreSQL 17 + Hasura CE 2.40 + Redis 7，采用 pnpm workspace monorepo 结构。

**Tech Stack:** Node.js 22 LTS, TypeScript 5.x, Fastify 5, PostgreSQL 17, Hasura CE, Redis 7, pnpm

---

## Task 1: 初始化 Monorepo 结构

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: 初始化 git 仓库**

```bash
cd /Users/cloudio/Developer/nodejs/Druvia
git init
```

**Step 2: 创建根 package.json**

```json
{
  "name": "druvia",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 3: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**Step 4: 创建 turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

**Step 5: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 6: 创建 .gitignore**

```
node_modules/
dist/
.env
.env.local
*.log
.turbo/
.DS_Store
```

**Step 7: 创建 .env.example**

```bash
# Database
POSTGRES_PASSWORD=your_secure_password

# Hasura
HASURA_ADMIN_SECRET=your_hasura_secret

# JWT
JWT_SECRET=your_jwt_secret_min_32_chars

# Storage
STORAGE_PROVIDER=local

# Redis
REDIS_URL=redis://localhost:6379
```

**Step 8: 安装依赖并提交**

```bash
pnpm install
git add .
git commit -m "chore: initialize monorepo structure"
```

---

## Task 2: 创建 shared 包

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/tenant.ts`
- Create: `packages/shared/src/utils/id.ts`
- Create: `packages/shared/src/index.ts`

**Step 1: 创建 packages/shared 目录结构**

```bash
mkdir -p packages/shared/src/types packages/shared/src/utils
```

**Step 2: 创建 packages/shared/package.json**

```json
{
  "name": "@druvia/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

**Step 3: 创建 packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

**Step 4: 创建 packages/shared/src/types/tenant.ts**

```typescript
export interface Tenant {
  id: number;
  tenantId: string;
  alias: string;
  name: string;
  ownerUid: number;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantInput {
  alias: string;
  name: string;
  ownerUid: number;
  plan?: 'free' | 'pro' | 'enterprise';
}

export interface UpdateTenantInput {
  name?: string;
  plan?: 'free' | 'pro' | 'enterprise';
  settings?: Record<string, unknown>;
  status?: 'active' | 'suspended';
}
```

**Step 5: 创建 packages/shared/src/types/index.ts**

```typescript
export * from './tenant';
```

**Step 6: 创建 packages/shared/src/utils/id.ts**

```typescript
import { randomBytes } from 'crypto';

export function generateId(prefix: string = ''): string {
  const bytes = randomBytes(12);
  const id = bytes.toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

export function generateTenantId(): string {
  return generateId('ten');
}

export function generateProjectId(): string {
  return generateId('proj');
}

export function generateUserId(): string {
  return generateId('usr');
}
```

**Step 7: 创建 packages/shared/src/index.ts**

```typescript
export * from './types';
export * from './utils/id';
```

**Step 8: 构建并提交**

```bash
pnpm install
pnpm --filter @druvia/shared build
git add .
git commit -m "feat: add shared package with types and utils"
```

---

## Task 3: 创建 API 应用基础结构

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/config/index.ts`
- Create: `apps/api/src/lib/db.ts`

**Step 1: 创建 apps/api 目录结构**

```bash
mkdir -p apps/api/src/config apps/api/src/lib apps/api/src/modules apps/api/src/middleware
```

**Step 2: 创建 apps/api/package.json**

```json
{
  "name": "@druvia/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "@druvia/shared": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/jwt": "^9.0.0",
    "pg": "^8.12.0",
    "ioredis": "^5.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.16.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

**Step 3: 创建 apps/api/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

**Step 4: 创建 apps/api/src/config/index.ts**

```typescript
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  HASURA_ENDPOINT: z.string().default('http://localhost:8080'),
  HASURA_ADMIN_SECRET: z.string(),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
```

**Step 5: 创建 apps/api/src/lib/db.ts**

```typescript
import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}
```

**Step 6: 创建 apps/api/src/index.ts**

```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';

const app = Fastify({
  logger: true,
});

async function start() {
  await app.register(cors, {
    origin: true,
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server running on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
```

**Step 7: 安装依赖并提交**

```bash
pnpm install
git add .
git commit -m "feat: add api app with fastify setup"
```

---

## Task 4: 创建 Docker Compose 配置

**Files:**
- Create: `docker/docker-compose.yml`
- Create: `docker/docker-compose.dev.yml`
- Create: `migrations/001_init_druvia.sql`

**Step 1: 创建 docker 目录**

```bash
mkdir -p docker migrations
```

**Step 2: 创建 docker/docker-compose.yml**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: druvia
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-druvia_dev}
      POSTGRES_DB: druvia
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ../migrations:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U druvia"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  hasura:
    image: hasura/graphql-engine:v2.40.0
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      HASURA_GRAPHQL_DATABASE_URL: postgres://druvia:${POSTGRES_PASSWORD:-druvia_dev}@postgres:5432/druvia
      HASURA_GRAPHQL_ADMIN_SECRET: ${HASURA_ADMIN_SECRET:-druvia_admin}
      HASURA_GRAPHQL_ENABLE_CONSOLE: "true"
      HASURA_GRAPHQL_DEV_MODE: "true"
    ports:
      - "8080:8080"

volumes:
  postgres_data:
```

**Step 3: 创建 migrations/001_init_druvia.sql**

```sql
-- Druvia Core Tables

-- 用户表
CREATE TABLE IF NOT EXISTS druvia_users (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  username VARCHAR(128),
  password_hash VARCHAR(255),
  avatar_url VARCHAR(512),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 租户表
CREATE TABLE IF NOT EXISTS druvia_tenants (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL,
  alias VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  owner_uid INT NOT NULL REFERENCES druvia_users(id),
  plan VARCHAR(20) DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 项目表
CREATE TABLE IF NOT EXISTS druvia_projects (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
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
CREATE TABLE IF NOT EXISTS druvia_schema_registry (
  id SERIAL PRIMARY KEY,
  schema_name VARCHAR(128) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id),
  schema_type VARCHAR(20) NOT NULL,
  table_count INT DEFAULT 0,
  function_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tenants_owner ON druvia_tenants(owner_uid);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON druvia_projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_schema_tenant ON druvia_schema_registry(tenant_id);
```

**Step 4: 提交**

```bash
git add .
git commit -m "feat: add docker compose and initial migration"
```

---

## Task 5: 实现租户管理模块

**Files:**
- Create: `apps/api/src/modules/tenant/tenant.service.ts`
- Create: `apps/api/src/modules/tenant/tenant.controller.ts`
- Create: `apps/api/src/modules/tenant/tenant.routes.ts`
- Create: `apps/api/src/modules/tenant/tenant.test.ts`

**Step 1: 创建 tenant 目录**

```bash
mkdir -p apps/api/src/modules/tenant
```

**Step 2: 创建 tenant.service.ts**

```typescript
import { query, queryOne, execute } from '../../lib/db';
import { generateTenantId } from '@druvia/shared';
import type { Tenant, CreateTenantInput, UpdateTenantInput } from '@druvia/shared';

export class TenantService {
  async create(input: CreateTenantInput): Promise<Tenant> {
    const tenantId = generateTenantId();
    const [tenant] = await query<Tenant>(
      `INSERT INTO druvia_tenants (tenant_id, alias, name, owner_uid, plan)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, input.alias, input.name, input.ownerUid, input.plan || 'free']
    );
    return tenant;
  }

  async findById(tenantId: string): Promise<Tenant | null> {
    return queryOne<Tenant>(
      'SELECT * FROM druvia_tenants WHERE tenant_id = $1',
      [tenantId]
    );
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    return queryOne<Tenant>(
      'SELECT * FROM druvia_tenants WHERE alias = $1',
      [alias]
    );
  }

  async list(ownerUid?: number): Promise<Tenant[]> {
    if (ownerUid) {
      return query<Tenant>(
        'SELECT * FROM druvia_tenants WHERE owner_uid = $1 ORDER BY created_at DESC',
        [ownerUid]
      );
    }
    return query<Tenant>('SELECT * FROM druvia_tenants ORDER BY created_at DESC');
  }

  async update(tenantId: string, input: UpdateTenantInput): Promise<Tenant | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.plan !== undefined) {
      sets.push(`plan = $${idx++}`);
      values.push(input.plan);
    }
    if (input.settings !== undefined) {
      sets.push(`settings = $${idx++}`);
      values.push(JSON.stringify(input.settings));
    }
    if (input.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(input.status);
    }

    if (sets.length === 0) return this.findById(tenantId);

    sets.push(`updated_at = NOW()`);
    values.push(tenantId);

    const [tenant] = await query<Tenant>(
      `UPDATE druvia_tenants SET ${sets.join(', ')} WHERE tenant_id = $${idx} RETURNING *`,
      values
    );
    return tenant || null;
  }

  async delete(tenantId: string): Promise<boolean> {
    const count = await execute(
      'DELETE FROM druvia_tenants WHERE tenant_id = $1',
      [tenantId]
    );
    return count > 0;
  }
}

export const tenantService = new TenantService();
```

**Step 3: 创建 tenant.controller.ts**

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { tenantService } from './tenant.service';
import type { CreateTenantInput, UpdateTenantInput } from '@druvia/shared';

export async function createTenant(
  request: FastifyRequest<{ Body: CreateTenantInput }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.create(request.body);
  return reply.status(201).send({ success: true, data: tenant });
}

export async function getTenant(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.findById(request.params.tenantId);
  if (!tenant) {
    return reply.status(404).send({ success: false, error: 'Tenant not found' });
  }
  return reply.send({ success: true, data: tenant });
}

export async function listTenants(
  request: FastifyRequest<{ Querystring: { ownerUid?: string } }>,
  reply: FastifyReply
) {
  const ownerUid = request.query.ownerUid ? parseInt(request.query.ownerUid) : undefined;
  const tenants = await tenantService.list(ownerUid);
  return reply.send({ success: true, data: tenants });
}

export async function updateTenant(
  request: FastifyRequest<{ Params: { tenantId: string }; Body: UpdateTenantInput }>,
  reply: FastifyReply
) {
  const tenant = await tenantService.update(request.params.tenantId, request.body);
  if (!tenant) {
    return reply.status(404).send({ success: false, error: 'Tenant not found' });
  }
  return reply.send({ success: true, data: tenant });
}

export async function deleteTenant(
  request: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply
) {
  const deleted = await tenantService.delete(request.params.tenantId);
  if (!deleted) {
    return reply.status(404).send({ success: false, error: 'Tenant not found' });
  }
  return reply.status(204).send();
}
```

**Step 4: 创建 tenant.routes.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import * as controller from './tenant.controller';

export async function tenantRoutes(app: FastifyInstance) {
  app.post('/api/tenants', controller.createTenant);
  app.get('/api/tenants', controller.listTenants);
  app.get('/api/tenants/:tenantId', controller.getTenant);
  app.put('/api/tenants/:tenantId', controller.updateTenant);
  app.delete('/api/tenants/:tenantId', controller.deleteTenant);
}
```

**Step 5: 更新 apps/api/src/index.ts 注册路由**

```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { tenantRoutes } from './modules/tenant/tenant.routes';

const app = Fastify({
  logger: true,
});

async function start() {
  await app.register(cors, { origin: true });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  await app.register(tenantRoutes);

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server running on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
```

**Step 6: 提交**

```bash
git add .
git commit -m "feat: add tenant management module"
```

---

## 后续任务概览

| Task | 内容 | 预计时间 |
|------|------|----------|
| Task 6 | 实现 JWT 认证中间件 | 2h |
| Task 7 | 实现用户注册/登录 | 3h |
| Task 8 | 实现 Schema 自动创建 | 3h |
| Task 9 | 实现项目管理模块 | 2h |
| Task 10 | 集成测试 + 文档 | 2h |

---

**Plan complete and saved to `docs/plans/2026-02-24-druvia-phase1-plan.md`.**

Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
