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

const MIGRATE_LOCK_ID = 20260313; // advisory lock ID

// 获取迁移锁，防止并发执行
async function acquireLock(): Promise<void> {
  const result = await pool.query('SELECT pg_try_advisory_lock($1) as acquired', [MIGRATE_LOCK_ID]);
  if (!result.rows[0].acquired) {
    throw new Error('Another migration is running. Aborting.');
  }
}

async function releaseLock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_ID]);
}

// migrate up: 执行所有未应用的迁移
async function migrateUp(): Promise<void> {
  await acquireLock();
  try {
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
  } finally {
    await releaseLock();
  }
}

// migrate down: 回滚迁移
async function migrateDown(targetVersion?: number): Promise<void> {
  await acquireLock();
  try {
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
  } finally {
    await releaseLock();
  }
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
  };

  // 纯数据迁移：通过查询数据行判断是否已应用
  const dataChecks: Record<number, string> = {
    10: `SELECT EXISTS (SELECT 1 FROM druvia_tenants WHERE tenant_id = 'default') as exists`,
    14: `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = '_meta_tables' AND column_name = 'realtime_enabled'
      LIMIT 1
    ) as exists`,
  };

  const result = await pool.query(`
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
      const r = await pool.query(dataQuery);
      applied = r.rows[0].exists;
    }

    if (applied) {
      await pool.query(
        'INSERT INTO druvia_schema_versions (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [m.version, m.name]
      );
      count++;
    } else {
      console.log(`  ○ ${String(m.version).padStart(3, '0')} ${m.name} (not detected, skipped)`);
    }
  }
  console.log(`Bootstrapped ${count} existing migration(s).`);
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
  } finally {
    await pool.end();
  }
})();
