# 版本管理与迁移系统 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Druvia 建立 up/down 双向迁移系统、schema 版本追踪和 tag 发布流程

**Architecture:** 现有 12 个单向迁移文件改为 up/down 双文件，新增 `migrate.ts` CLI 工具直连 PostgreSQL 执行迁移，通过 `druvia_schema_versions` 表追踪状态

**Tech Stack:** Node.js + pg + tsx, 无额外依赖

**Spec:** `docs/plans/2026-03-13-version-management-design.md`

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| Create | `apps/api/src/cli/migrate.ts` | 迁移 CLI 工具 |
| Create | `migrations/000_schema_versions.up.sql` | 创建版本追踪表 |
| Create | `migrations/000_schema_versions.down.sql` | 删除版本追踪表 |
| Rename | `migrations/001_init_druvia.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/001_init_druvia.down.sql` | 回滚脚本 |
| Rename | `migrations/002_user_roles.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/002_user_roles.down.sql` | 回滚脚本 |
| Rename | `migrations/003_tenant_limits.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/003_tenant_limits.down.sql` | 回滚脚本 |
| Rename | `migrations/004_settings_table.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/004_settings_table.down.sql` | 回滚脚本 |
| Rename | `migrations/005_activity_logs.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/005_activity_logs.down.sql` | 回滚脚本 |
| Rename | `migrations/006_project_db_credentials.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/006_project_db_credentials.down.sql` | 回滚脚本 |
| Rename | `migrations/007_storage_redesign.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/007_storage_redesign.down.sql` | 回滚脚本 |
| Rename | `migrations/008_auth_admin.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/008_auth_admin.down.sql` | 回滚脚本 |
| Rename+Fix | `migrations/008_edge_functions.sql` → `009_edge_functions.up.sql` | 修正编号冲突 |
| Create | `migrations/009_edge_functions.down.sql` | 回滚脚本 |
| Rename | `migrations/010_create_default_tenant.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/010_create_default_tenant.down.sql` | 回滚脚本 |
| Rename | `migrations/011_create_api_keys.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/011_create_api_keys.down.sql` | 回滚脚本 |
| Rename | `migrations/012_create_project_environments.sql` → `.up.sql` | 现有迁移重命名 |
| Create | `migrations/012_create_project_environments.down.sql` | 回滚脚本 |
| Modify | `package.json` | 添加 migrate script（通过 pnpm filter 调用 api 包的 tsx） |
| Create | `docs/migration/supabase-compat.md` | 迁移兼容性文档模板 |

---

## Task 1: 修正迁移文件编号冲突并重命名为 up/down 格式

**Files:**
- Rename: `migrations/*.sql` → `migrations/*.up.sql`
- Fix: `migrations/008_edge_functions.sql` → `migrations/009_edge_functions.up.sql`

- [ ] **Step 1: 修正编号冲突**

`008_edge_functions.sql` 与 `008_auth_admin.sql` 编号重复，重命名为 `009`：

```bash
cd migrations
mv 008_edge_functions.sql 009_edge_functions.sql
```

- [ ] **Step 2: 批量重命名为 .up.sql**

```bash
cd migrations
for f in *.sql; do
  mv "$f" "${f%.sql}.up.sql"
done
```

验证：`ls migrations/` 应显示所有文件以 `.up.sql` 结尾，且编号无冲突（001-012，无重复）。

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "refactor(migrations): rename to up/down format, fix 008 duplicate"
```

---

## Task 2: 创建 schema_versions 迁移文件

**Files:**
- Create: `migrations/000_schema_versions.up.sql`
- Create: `migrations/000_schema_versions.down.sql`

- [ ] **Step 1: 创建 up 迁移**

```sql
-- migrations/000_schema_versions.up.sql
CREATE TABLE IF NOT EXISTS druvia_schema_versions (
  version INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: 创建 down 迁移**

```sql
-- migrations/000_schema_versions.down.sql
DROP TABLE IF EXISTS druvia_schema_versions;
```

- [ ] **Step 3: Commit**

```bash
git add migrations/000_schema_versions.*
git commit -m "feat(migrations): add schema_versions tracking table"
```

---

## Task 3: 实现 migrate CLI 工具

**Files:**
- Create: `apps/api/src/cli/migrate.ts`
- Modify: `package.json` (添加 migrate script)

- [ ] **Step 1: 创建 migrate.ts**

```typescript
// apps/api/src/cli/migrate.ts
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.DB_NAME || 'druvia',
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../migrations');

interface MigrationFile {
  version: number;
  name: string;
  filename: string;
}

// 扫描 migrations 目录，返回排序后的迁移列表
function scanMigrations(direction: 'up' | 'down'): MigrationFile[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(`.${direction}.sql`))
    .map(f => {
      const match = f.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
      if (!match) return null;
      return { version: parseInt(match[1], 10), name: match[2], filename: f };
    })
    .filter((m): m is MigrationFile => m !== null)
    .sort((a, b) => direction === 'up' ? a.version - b.version : b.version - a.version);
  return files;
}

// 确保 schema_versions 表存在
async function ensureVersionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS druvia_schema_versions (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// 获取已应用的版本列表
async function getAppliedVersions(): Promise<Set<number>> {
  const result = await pool.query('SELECT version FROM druvia_schema_versions ORDER BY version');
  return new Set(result.rows.map((r: { version: number }) => r.version));
}

// migrate up: 执行所有未应用的迁移
async function migrateUp(): Promise<void> {
  await ensureVersionTable();
  const applied = await getAppliedVersions();
  const migrations = scanMigrations('up').filter(m => !applied.has(m.version));

  if (migrations.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const m of migrations) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.filename), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO druvia_schema_versions (version, name) VALUES ($1, $2)',
        [m.version, m.name]
      );
      await client.query('COMMIT');
      console.log(`  ✓ ${m.filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${m.filename}: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(`Applied ${migrations.length} migration(s).`);
}

// migrate down: 回滚迁移
async function migrateDown(targetVersion?: number): Promise<void> {
  await ensureVersionTable();
  const applied = await getAppliedVersions();
  const migrations = scanMigrations('down').filter(m => applied.has(m.version));

  if (migrations.length === 0) {
    console.log('No migrations to rollback.');
    return;
  }

  let count = 0;
  for (const m of migrations) {
    if (targetVersion !== undefined && m.version <= targetVersion) break;
    if (targetVersion === undefined && count >= 1) break; // 默认只回滚一个

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.filename), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('DELETE FROM druvia_schema_versions WHERE version = $1', [m.version]);
      await client.query('COMMIT');
      console.log(`  ↓ ${m.filename}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${m.filename}: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(`Rolled back ${count} migration(s).`);
}

// migrate status: 显示迁移状态
async function migrateStatus(): Promise<void> {
  await ensureVersionTable();
  const applied = await getAppliedVersions();
  const migrations = scanMigrations('up');

  console.log('Migration Status:');
  console.log('─'.repeat(60));
  for (const m of migrations) {
    const status = applied.has(m.version) ? '✓' : '○';
    console.log(`  ${status} ${String(m.version).padStart(3, '0')} ${m.name}`);
  }
  console.log('─'.repeat(60));
  const current = applied.size > 0 ? Math.max(...applied) : 'none';
  console.log(`Current version: ${current}`);
}

// 引导已有迁移：首次运行时标记已存在的迁移为已应用
// 跳过 000（schema_versions 由 ensureVersionTable 内联创建）
async function bootstrap(): Promise<void> {
  await ensureVersionTable();
  const applied = await getAppliedVersions();
  if (applied.size > 0) {
    console.log('Already bootstrapped.');
    return;
  }

  // 检测数据库是否已有 druvia_users 表（说明迁移已手动执行过）
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'druvia_users'
    ) as exists
  `);

  if (!result.rows[0].exists) {
    console.log('Fresh database, no bootstrap needed.');
    return;
  }

  const migrations = scanMigrations('up').filter(m => m.version > 0);
  for (const m of migrations) {
    await pool.query(
      'INSERT INTO druvia_schema_versions (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [m.version, m.name]
    );
  }
  console.log(`Bootstrapped ${migrations.length} existing migration(s).`);
}

// CLI 入口
const [command, ...args] = process.argv.slice(2);

(async () => {
  try {
    switch (command) {
      case 'up':
        await migrateUp();
        break;
      case 'down': {
        const toIdx = args.indexOf('--to');
        const target = toIdx !== -1 ? parseInt(args[toIdx + 1], 10) : undefined;
        await migrateDown(target);
        break;
      }
      case 'status':
        await migrateStatus();
        break;
      case 'bootstrap':
        await bootstrap();
        break;
      default:
        console.log('Usage: pnpm migrate <up|down|status|bootstrap>');
        console.log('  up              Apply all pending migrations');
        console.log('  down            Rollback last migration');
        console.log('  down --to N     Rollback to version N');
        console.log('  status          Show migration status');
        console.log('  bootstrap       Mark existing migrations as applied');
    }
  } finally {
    await pool.end();
  }
})();
```

- [ ] **Step 2: 在 package.json 添加 migrate script**

在根 `package.json` 的 `scripts` 中添加：

```json
"migrate": "pnpm --filter @druvia/api exec tsx src/cli/migrate.ts"
```

- [ ] **Step 3: 验证 CLI 帮助信息**

```bash
pnpm migrate
```

Expected: 显示 Usage 帮助信息。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/cli/migrate.ts package.json
git commit -m "feat(cli): add migrate command with up/down/status/bootstrap"
```

---

## Task 4: 创建所有 down 迁移脚本

**Files:**
- Create: `migrations/001_init_druvia.down.sql` ~ `migrations/012_create_project_environments.down.sql`

注意：down 脚本按依赖关系反向删除。部分 down 脚本是"尽力回滚"——包含数据的表（如 `druvia_users`）回滚会丢失数据，这是预期行为。

- [ ] **Step 1: 001_init_druvia.down.sql**

```sql
-- 001_init_druvia.down.sql
-- WARNING: 回滚将删除所有核心表和数据

BEGIN;

-- 先删触发器
DROP TRIGGER IF EXISTS druvia_tenant_storage_config_updated_at ON druvia_tenant_storage_config;
DROP TRIGGER IF EXISTS druvia_tenant_auth_providers_updated_at ON druvia_tenant_auth_providers;
DROP TRIGGER IF EXISTS druvia_files_updated_at ON druvia_files;
DROP TRIGGER IF EXISTS druvia_schema_registry_updated_at ON druvia_schema_registry;
DROP TRIGGER IF EXISTS druvia_projects_updated_at ON druvia_projects;
DROP TRIGGER IF EXISTS druvia_tenants_updated_at ON druvia_tenants;
DROP TRIGGER IF EXISTS druvia_users_updated_at ON druvia_users;

-- 按依赖顺序删表
DROP TABLE IF EXISTS druvia_user_providers CASCADE;
DROP TABLE IF EXISTS druvia_tenant_storage_config CASCADE;
DROP TABLE IF EXISTS druvia_tenant_auth_providers CASCADE;
DROP TABLE IF EXISTS druvia_files CASCADE;
DROP TABLE IF EXISTS druvia_backups CASCADE;
DROP TABLE IF EXISTS druvia_schema_registry CASCADE;
DROP TABLE IF EXISTS druvia_projects CASCADE;
DROP TABLE IF EXISTS druvia_tenants CASCADE;
DROP TABLE IF EXISTS druvia_users CASCADE;

DROP FUNCTION IF EXISTS druvia_update_updated_at();

COMMIT;
```

- [ ] **Step 2: 002_user_roles.down.sql**

```sql
-- 002_user_roles.down.sql
DROP INDEX IF EXISTS idx_druvia_users_role;
ALTER TABLE druvia_users DROP COLUMN IF EXISTS role;
```

- [ ] **Step 3: 003_tenant_limits.down.sql**

```sql
-- 003_tenant_limits.down.sql
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS description;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS storage_limit;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS project_limit;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS user_limit;
```

- [ ] **Step 4: 004_settings_table.down.sql**

```sql
-- 004_settings_table.down.sql
DROP TRIGGER IF EXISTS druvia_settings_updated_at ON druvia_settings;
DROP TABLE IF EXISTS druvia_settings;
```

- [ ] **Step 5: 005_activity_logs.down.sql**

```sql
-- 005_activity_logs.down.sql
DROP TABLE IF EXISTS druvia_activity_logs;
```

- [ ] **Step 6: 006_project_db_credentials.down.sql**

```sql
-- 006_project_db_credentials.down.sql
DROP INDEX IF EXISTS idx_druvia_projects_db_user;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_user;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_password_hash;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_created_at;
```

- [ ] **Step 7: 007_storage_redesign.down.sql**

```sql
-- 007_storage_redesign.down.sql
BEGIN;
DROP TRIGGER IF EXISTS druvia_storage_objects_updated_at ON druvia_storage_objects;
DROP TRIGGER IF EXISTS druvia_storage_buckets_updated_at ON druvia_storage_buckets;
DROP TABLE IF EXISTS druvia_storage_objects CASCADE;
DROP TABLE IF EXISTS druvia_storage_buckets CASCADE;
COMMIT;
```

- [ ] **Step 8: 008_auth_admin.down.sql**

```sql
-- 008_auth_admin.down.sql
BEGIN;
DROP TRIGGER IF EXISTS druvia_project_auth_config_updated_at ON druvia_project_auth_config;
DROP TRIGGER IF EXISTS druvia_project_auth_providers_updated_at ON druvia_project_auth_providers;
DROP TABLE IF EXISTS druvia_project_auth_config;
DROP TABLE IF EXISTS druvia_project_auth_providers;
COMMIT;
```

- [ ] **Step 9: 009_edge_functions.down.sql**

```sql
-- 009_edge_functions.down.sql
BEGIN;
DROP TABLE IF EXISTS druvia_function_logs CASCADE;
DROP TABLE IF EXISTS druvia_function_schedules CASCADE;
DROP TABLE IF EXISTS druvia_function_secrets CASCADE;
DROP TABLE IF EXISTS druvia_functions CASCADE;
COMMIT;
```

- [ ] **Step 10: 010_create_default_tenant.down.sql**

```sql
-- 010_create_default_tenant.down.sql
-- 注意：如果 admin 用户是 001 创建的 usr_admin，此 DELETE 可能匹配不到 user_id='admin' 的行
-- 这是安全的 — ON CONFLICT DO NOTHING 意味着 010 可能未插入新用户
DELETE FROM druvia_tenants WHERE tenant_id = 'default';
DELETE FROM druvia_users WHERE email = 'admin@druvia.local' AND user_id = 'admin';
```

- [ ] **Step 11: 011_create_api_keys.down.sql**

```sql
-- 011_create_api_keys.down.sql
DROP TABLE IF EXISTS druvia_api_keys;
```

- [ ] **Step 12: 012_create_project_environments.down.sql**

```sql
-- 012_create_project_environments.down.sql
DROP TABLE IF EXISTS druvia_project_environments;
```

- [ ] **Step 13: Commit**

```bash
git add migrations/*.down.sql
git commit -m "feat(migrations): add down scripts for all existing migrations"
```

---

## Task 5: 引导已有数据库并验证

- [ ] **Step 1: 在已有数据库上执行 bootstrap**

```bash
pnpm migrate bootstrap
```

Expected: `Bootstrapped 12 existing migration(s).`（001-012，跳过 000）

- [ ] **Step 2: 验证 status**

```bash
pnpm migrate status
```

Expected: 所有迁移显示 `✓`，当前版本 `12`。

- [ ] **Step 3: 测试 down/up 往返**

```bash
# 回滚最后一个
pnpm migrate down
# 验证
pnpm migrate status
# 重新应用
pnpm migrate up
# 验证恢复
pnpm migrate status
```

Expected: down 后版本变为 `11`，up 后恢复为 `12`。

---

## Task 6: 创建迁移兼容性文档

**Files:**
- Create: `docs/migration/supabase-compat.md`

- [ ] **Step 1: 创建文档**

```markdown
# Supabase → Druvia 迁移兼容性对照

## 功能对照表

| Supabase 功能 | Druvia 对应 | 状态 | 版本 | Issue |
|--------------|-------------|------|------|-------|
| **Auth** | | | | |
| supabase.auth.signUp() | POST /api/v1/auth/register | ✅ | v0.1.0 | |
| supabase.auth.signInWithPassword() | POST /api/v1/auth/login | ✅ | v0.1.0 | |
| supabase.auth.signInWithOAuth() | GET /api/v1/auth/oauth/:provider | ✅ | v0.1.0 | |
| supabase.auth.signOut() | POST /api/v1/auth/logout | ✅ | v0.1.0 | |
| supabase.auth.getUser() | GET /api/v1/auth/me | ✅ | v0.1.0 | |
| **Database** | | | | |
| supabase.from().select() | GraphQL query (Hasura) | ✅ | v0.1.0 | |
| supabase.from().insert() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.from().update() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.from().delete() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.rpc() | Hasura Actions | 🚧 | - | |
| Row Level Security | - | ❌ | - | |
| **Realtime** | | | | |
| supabase.channel().on() | Hasura Subscriptions | 🚧 | - | |
| Broadcast | - | ❌ | - | |
| Presence | - | ❌ | - | |
| **Storage** | | | | |
| supabase.storage.from().upload() | POST /api/v1/projects/:id/storage/buckets/:name/objects | ✅ | v0.1.0 | |
| supabase.storage.from().download() | GET /api/v1/projects/:id/storage/buckets/:name/objects/* | ✅ | v0.1.0 | |
| supabase.storage.from().getPublicUrl() | GET /api/v1/storage/public/:projectId/:bucketName/* | ✅ | v0.1.0 | |
| supabase.storage.from().createSignedUrl() | POST /api/v1/projects/:id/storage/buckets/:name/sign | ✅ | v0.1.0 | |
| Image transformations | - | ❌ | - | |
| **Edge Functions** | | | | |
| supabase.functions.invoke() | - | 🚧 | - | |

## 状态说明

- ✅ 已完成 — 可直接使用
- 🚧 开发中 — 部分可用或计划中
- ❌ 待开发 — 尚未实现

## 迁移注意事项

1. Supabase 使用 REST API + PostgREST，Druvia 使用 GraphQL (Hasura)
2. 认证 JWT 格式不同，需要更新前端 token 处理逻辑
3. Storage API 路径不同，需要替换所有上传/下载调用
4. RLS 在 Druvia 中暂不支持，需要通过 Hasura 权限系统替代
```

- [ ] **Step 2: Commit**

```bash
git add docs/migration/supabase-compat.md
git commit -m "docs: add Supabase migration compatibility reference"
```

---

## Task 7: 打 v0.1.0 基线 Tag

- [ ] **Step 1: 确认工作区干净**

```bash
git status
```

Expected: `nothing to commit, working tree clean`

- [ ] **Step 2: 打 tag**

```bash
git tag -a v0.1.0 -m "v0.1.0: 迁移系统就绪，案例迁移起点"
```

- [ ] **Step 3: 推送 tag**

```bash
git push origin v0.1.0
```

---

*Last Updated: 2026-03-13*
