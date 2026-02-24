---
name: database-guide
description: This skill should be used when the user asks about "database schema", "tenant tables", "migrations", "druvia_tenants", "Schema-per-Tenant", "PostgreSQL", or mentions "database design", "table structure", "SQL queries".
---

# Database Design Guide

Druvia 平台数据库设计指南。

## Schema-per-Tenant 架构

```
PostgreSQL
├── public (Druvia 核心)
│   ├── druvia_tenants
│   ├── druvia_projects
│   ├── druvia_users
│   └── ...
│
├── tenant_acme (租户 A)
│   ├── _meta_tables
│   ├── _meta_functions
│   └── [业务表...]
│
└── tenant_beta (租户 B)
    └── ...
```

## 核心表 (public schema)

### druvia_tenants

```sql
CREATE TABLE druvia_tenants (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL,  -- ten_xxx
  alias VARCHAR(64) UNIQUE NOT NULL,       -- acme
  name VARCHAR(255) NOT NULL,
  owner_uid INT NOT NULL REFERENCES druvia_users(id),
  plan VARCHAR(20) DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### druvia_projects

```sql
CREATE TABLE druvia_projects (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL,  -- proj_xxx
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  alias VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  schema_name VARCHAR(128),  -- tenant_acme_proj_shop
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, alias)
);
```

### druvia_backups

```sql
CREATE TABLE druvia_backups (
  id SERIAL PRIMARY KEY,
  backup_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64),
  schema_name VARCHAR(128) NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  size_bytes BIGINT DEFAULT 0,
  tables_count INT DEFAULT 0,
  tables_list JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

## 租户 Schema 元数据表

每个租户 Schema 内自动创建：

```sql
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
  parameters JSONB DEFAULT '[]',
  return_type VARCHAR(64),
  language VARCHAR(20) DEFAULT 'plpgsql',
  definition TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 视图元数据
CREATE TABLE _meta_views (
  id SERIAL PRIMARY KEY,
  view_name VARCHAR(128) UNIQUE NOT NULL,
  view_type VARCHAR(20) NOT NULL,  -- view | materialized
  definition TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Schema 命名规则

```
租户级：tenant_{alias}
项目级：tenant_{alias}_proj_{project_alias}

示例：
- tenant_acme
- tenant_acme_proj_shop
- tenant_acme_proj_blog
```

## 常用查询

```sql
-- 查看所有租户 Schema
SELECT schema_name FROM information_schema.schemata
WHERE schema_name LIKE 'tenant_%';

-- 查看租户的所有表
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'tenant_acme';

-- 查看 Schema 大小
SELECT pg_size_pretty(pg_total_relation_size('tenant_acme._meta_tables'));
```

## 数据库连接

```typescript
// apps/api/src/lib/db.ts
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
```

## 重要规则

### JSONB 字段处理

```typescript
// ✅ 正确: 直接传递对象，pg 驱动自动转换
await query('INSERT INTO table (settings) VALUES ($1)', [{ key: 'value' }]);

// ❌ 错误: 不要用 JSON.stringify，会导致双重编码
await query('INSERT INTO table (settings) VALUES ($1)', [JSON.stringify({ key: 'value' })]);
```

### 外键级联删除

租户相关表必须使用 `ON DELETE CASCADE`：

```sql
-- ✅ 正确
CREATE TABLE druvia_projects (
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE
);

-- ❌ 错误: 删除租户时会因外键约束失败
CREATE TABLE druvia_projects (
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id)
);
```

## 迁移文件

迁移文件位于 `migrations/` 目录：

```
migrations/
├── 001_init_druvia.sql      # 核心表
├── 002_add_backups.sql      # 备份表
├── 003_add_auth_tables.sql  # 认证相关表
└── ...
```
