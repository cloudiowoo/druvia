import type { PoolClient } from 'pg';
import { pool } from '../../db/index.js';
import { getDefaultStorageAdapter } from '../../adapters/storage/index.js';
import { createApiLogger } from '../../lib/logger.js';
import { executeProjectBackupGuard, loadProjectBackupGuards, writeGuardJournal, ProjectBackupGuardError, type ProjectBackupGuard } from './project-backup-guard.js';

const logger = createApiLogger({ module: 'project-backup-retention' });
export interface ManagedBackupObject {
  backup_id: string; tenant_id: string; project_id: string | null; schema_name: string; storage_key: string;
}
export interface BackupRetentionResult { checked: number; removed: number; failed: number }

export async function withManagedBackupLock<T>(guard: ProjectBackupGuard, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  try {
    await client.query("SET lock_timeout='30s'");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`project-backups:${guard.projectId}`]);
    locked = true;
    return await action(client);
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`project-backups:${guard.projectId}`]);
      await client.query('RESET lock_timeout');
    } catch { discard = true; }
    client.release(discard);
  }
}

export async function guardTransaction<T>(client: PoolClient, action: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try { const result = await action(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function deleteManagedBackupObject(client: PoolClient, backup: ManagedBackupObject): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(backup.tenant_id) || !/^[A-Za-z0-9_-]+$/.test(backup.backup_id)
    || backup.storage_key !== `backups/${backup.tenant_id}/${backup.backup_id}.dump`) throw new ProjectBackupGuardError();
  const storage = getDefaultStorageAdapter();
  if (storage.name !== 'local') throw new ProjectBackupGuardError();
  await storage.delete(backup.storage_key);
  if (await storage.exists(backup.storage_key)) throw new ProjectBackupGuardError();
  // Keep the row if storage failed; a crash after deletion safely retries the missing object.
  await client.query(
    'DELETE FROM public.druvia_backups WHERE backup_id=$1 AND storage_key=$2 AND schema_name=$3',
    [backup.backup_id, backup.storage_key, backup.schema_name],
  );
}

export async function runProjectBackupRetention(): Promise<BackupRetentionResult> {
  const result = { checked: 0, removed: 0, failed: 0 };
  const guards = await loadProjectBackupGuards();
  if (guards.length && getDefaultStorageAdapter().name !== 'local') throw new ProjectBackupGuardError();
  for (const guard of guards) {
    try {
      await withManagedBackupLock(guard, async client => {
        const rows = await client.query<ManagedBackupObject>(
          `SELECT b.backup_id,b.tenant_id,b.project_id,b.schema_name,b.storage_key
           FROM public.druvia_backups b JOIN public.druvia_projects p
             ON p.project_id=$1 AND p.schema_name=$2 AND p.tenant_id=b.tenant_id
           WHERE b.schema_name=$2 AND (b.project_id=$1 OR b.project_id IS NULL)
             AND b.created_at <= clock_timestamp()-make_interval(days=>$3)
           ORDER BY b.created_at,b.backup_id LIMIT 26`,
          [guard.projectId, guard.schemaName, guard.retentionDays],
        );
        for (const row of rows.rows.slice(0, 25)) {
          await deleteManagedBackupObject(client, row);
          result.removed += 1;
        }
        if (rows.rows.length > 25) throw new ProjectBackupGuardError();
        const journal = await guardTransaction(client, () => executeProjectBackupGuard(client, guard, 'export'));
        await writeGuardJournal(guard, journal);
        await guardTransaction(client, () => executeProjectBackupGuard(client, guard, 'retention'));
        result.checked += 1;
      });
    } catch {
      result.failed += 1;
      // Never log the underlying SQL, storage response or receipt contents.
      logger.warn('project backup protection requires attention', { code: 'PROJECT_BACKUP_GUARD_REQUIRED' });
    }
  }
  return result;
}

export function startProjectBackupRetention(options: {
  intervalMs?: number; run?: () => Promise<BackupRetentionResult>;
  onResult?: (result: BackupRetentionResult) => void;
} = {}): () => Promise<void> {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const run = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try { const result = await (options.run ?? runProjectBackupRetention)(); options.onResult?.(result); }
      catch { logger.warn('project backup protection cycle failed', { code: 'PROJECT_BACKUP_GUARD_REQUIRED' }); }
    })().finally(() => { pending = undefined; });
  };
  const timer = setInterval(run, options.intervalMs ?? 15 * 60 * 1000);
  timer.unref();
  run();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
