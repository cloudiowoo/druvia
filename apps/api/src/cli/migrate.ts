// apps/api/src/cli/migrate.ts
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { stripMigrationTransactionWrapper } from './migration-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const { Pool } = pg;
type PoolClient = pg.PoolClient;

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
async function ensureVersionTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS druvia_schema_versions (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// 获取已应用的版本列表
async function getAppliedVersions(client: PoolClient): Promise<Set<number>> {
  const result = await client.query('SELECT version FROM druvia_schema_versions ORDER BY version');
  return new Set(result.rows.map((r: { version: number }) => r.version));
}

const MIGRATE_LOCK_ID = 20260313; // advisory lock ID

// 获取迁移锁，防止并发执行
async function acquireLock(client: PoolClient): Promise<void> {
  const result = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [MIGRATE_LOCK_ID]);
  if (!result.rows[0].acquired) {
    throw new Error('Another migration is running. Aborting.');
  }
}

async function releaseLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_ID]);
}

function readMigrationSql(migration: MigrationFile): string {
  return stripMigrationTransactionWrapper(
    fs.readFileSync(path.join(MIGRATIONS_DIR, migration.filename), 'utf-8')
  );
}

// migrate up: 执行所有未应用的迁移
async function migrateUp(): Promise<void> {
  const client = await pool.connect();
  try {
  await acquireLock(client);
  await ensureVersionTable(client);
  const applied = await getAppliedVersions(client);
  const migrations = scanMigrations('up').filter(m => !applied.has(m.version));

  if (migrations.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const m of migrations) {
    const sql = readMigrationSql(m);
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
      throw err;
    }
  }
  console.log(`Applied ${migrations.length} migration(s).`);
  } finally {
    try {
      await releaseLock(client);
    } finally {
      client.release();
    }
  }
}

// migrate down: 回滚迁移
async function migrateDown(targetVersion?: number): Promise<void> {
  const client = await pool.connect();
  try {
  await acquireLock(client);
  await ensureVersionTable(client);
  const applied = await getAppliedVersions(client);
  const migrations = scanMigrations('down').filter(m => applied.has(m.version));

  if (migrations.length === 0) {
    console.log('No migrations to rollback.');
    return;
  }

  let count = 0;
  for (const m of migrations) {
    if (targetVersion !== undefined && m.version <= targetVersion) break;
    if (targetVersion === undefined && count >= 1) break; // 默认只回滚一个

    const sql = readMigrationSql(m);
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
      throw err;
    }
  }
  console.log(`Rolled back ${count} migration(s).`);
  } finally {
    try {
      await releaseLock(client);
    } finally {
      client.release();
    }
  }
}

// migrate status: 显示迁移状态
async function migrateStatus(): Promise<void> {
  const client = await pool.connect();
  try {
  await ensureVersionTable(client);
  const applied = await getAppliedVersions(client);
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
  } finally {
    client.release();
  }
}

// 引导已有迁移：首次运行时标记已存在的迁移为已应用
// 跳过 000（schema_versions 由 ensureVersionTable 内联创建）
async function bootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
  await acquireLock(client);
  await ensureVersionTable(client);
  const applied = await getAppliedVersions(client);
  if (applied.size > 0) {
    console.log('Already bootstrapped.');
    return;
  }

  // 检测各迁移对应的关键表是否存在，逐个标记
  const tableChecks: Record<number, string> = {
    1: 'druvia_users',
    2: 'druvia_users',       // ALTER TABLE, 检查同一张表即可
    3: 'druvia_tenants',
    4: 'druvia_settings',
    5: 'druvia_activity_logs',
    6: 'druvia_projects',    // ALTER TABLE
    7: 'druvia_storage_buckets',
    8: 'druvia_project_auth_providers',
    9: 'druvia_functions',
    // 010 通过数据行检查，见下方 dataChecks
    11: 'druvia_api_keys',
    12: 'druvia_project_environments',
    13: 'druvia_refresh_tokens',
    16: 'druvia_project_refresh_tokens',
    17: 'druvia_trusted_backend_keys',
    19: 'druvia_data_access_migrations',
    23: 'druvia_data_access_managed_policies',
    24: 'druvia_table_deletion_outbox',
  };

  // 纯数据迁移：通过查询数据行判断是否已应用
  const dataChecks: Record<number, string> = {
    10: `SELECT EXISTS (SELECT 1 FROM druvia_tenants WHERE tenant_id = 'default') as exists`,
    14: `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = '_meta_tables' AND column_name = 'realtime_enabled'
      LIMIT 1
    ) as exists`,
    15: `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'druvia_functions' AND column_name = 'invoke_auth_mode'
      LIMIT 1
    ) as exists`,
    18: `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'druvia_projects'
        AND column_name = 'data_access_mode'
      LIMIT 1
    ) as exists`,
    20: `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'druvia_storage_buckets'
        AND column_name = 'project_user_access'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'druvia_storage_objects'
        AND column_name = 'owner_project_user_id'
    ) as exists`,
    21: `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'druvia_project_auth_identities'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'druvia_project_auth_provider_tokens'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'druvia_project_auth_events'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'druvia_project_refresh_tokens'
        AND column_name = 'identity_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'druvia_project_refresh_tokens'
        AND column_name = 'provider_audience'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'druvia_project_refresh_tokens'
        AND constraint_name = 'druvia_project_refresh_tokens_apple_identity_check'
    ) as exists`,
    22: `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'druvia_project_members'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'druvia_project_members'
        AND constraint_name = 'druvia_project_members_role_check'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'druvia_project_members'
        AND constraint_name = 'druvia_project_members_project_user_key'
    ) AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'druvia_project_members'
        AND indexname = 'idx_druvia_project_members_user'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'druvia_project_members'
        AND trigger_name = 'druvia_project_members_updated_at'
    ) as exists`,
  };

  const result = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const existingTables = new Set(result.rows.map((r: { table_name: string }) => r.table_name));

  if (!existingTables.has('druvia_users')) {
    console.log('Fresh database, no bootstrap needed.');
    return;
  }

  const migrations = scanMigrations('up').filter(m => m.version > 0);
  let count = 0;
  for (const m of migrations) {
    let applied = false;

    const checkTable = tableChecks[m.version];
    if (checkTable) {
      applied = existingTables.has(checkTable);
    }

    const dataQuery = dataChecks[m.version];
    if (dataQuery) {
      const r = await client.query(dataQuery);
      applied = r.rows[0].exists;
    }

    if (applied) {
      await client.query(
        'INSERT INTO druvia_schema_versions (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [m.version, m.name]
      );
      count++;
    } else {
      console.log(`  ○ ${String(m.version).padStart(3, '0')} ${m.name} (not detected, skipped)`);
    }
  }
  console.log(`Bootstrapped ${count} existing migration(s).`);
  } finally {
    try {
      await releaseLock(client);
    } finally {
      client.release();
    }
  }
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
        let target: number | undefined;
        if (toIdx !== -1) {
          target = parseInt(args[toIdx + 1], 10);
          if (isNaN(target)) throw new Error(`Invalid --to version: "${args[toIdx + 1]}"`);
        }
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
        console.log('  down --to N     Rollback to version N (keeps N applied)');
        console.log('  status          Show migration status');
        console.log('  bootstrap       Mark existing migrations as applied');
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
