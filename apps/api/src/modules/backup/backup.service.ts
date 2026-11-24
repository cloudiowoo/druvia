import { spawn } from 'child_process';
import { query, queryOne, pool } from '../../db/index.js';
import { generateBackupId } from '@druvia/shared';
import { getDefaultStorageAdapter } from '../../adapters/storage/index.js';
import { config } from '../../config/index.js';
import { createApiLogger } from '../../lib/logger.js';
import {
  buildDirectPgDumpCommand,
  buildDirectPgRestoreCommand,
  buildDockerPgDumpCommand,
  buildDockerPgRestoreCommand,
  runWithEnoentFallback,
  type CommandSpec,
} from './backup-command.js';
import {
  withProjectDataAccessMutationLock,
} from '../data-access/data-access-mutation-lock.js';
import {
  beginProjectRestoreGate,
  markProjectRestoreRecoveryRequired,
  replayProjectAccountDeletionFences,
} from '../project-auth/project-account-deletion-restore.service.js';
import { withProjectAuthProjectLock } from '../project-auth/project-identity.repository.js';

import { loadProjectBackupGuards, executeProjectBackupGuard, ProjectBackupGuardError, type ProjectBackupGuard } from './project-backup-guard.js';
import { withManagedBackupLock, guardTransaction, deleteManagedBackupObject } from './project-backup-retention.js';

const logger = createApiLogger({ module: 'backup' });

// Backup row type
interface BackupRow {
  id: number;
  backup_id: string;
  tenant_id: string;
  project_id: string | null;
  schema_name: string;
  storage_key: string;
  size_bytes: number;
  tables_count: number;
  tables_list: string[];
  status: string;
  error_message: string | null;
  created_by: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface Backup {
  id: number;
  backupId: string;
  tenantId: string;
  projectId: string | null;
  schemaName: string;
  storageKey: string;
  sizeBytes: number;
  tablesCount: number;
  tablesList: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  errorMessage: string | null;
  createdBy: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface BackupListItem {
  backupId: string;
  tenantId: string;
  projectId: string | null;
  schemaName: string;
  status: Backup['status'];
  sizeBytes: number;
  createdAt: Date;
}

export function projectRestoreRecoveryReason(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (
    code === 'PROJECT_BACKUP_GUARD_REQUIRED'
    || code === 'DEVICE_WIPE_BINDING_REPLAY_REQUIRED'
    || code === 'DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED'
    || code === 'DEVICE_WIPE_RESTORE_TIMEOUT'
  ) return code;
  return 'ACCOUNT_DELETION_FENCE_REPLAY_REQUIRED';
}

function toBackup(row: BackupRow): Backup {
  return {
    id: row.id,
    backupId: row.backup_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    schemaName: row.schema_name,
    storageKey: row.storage_key,
    sizeBytes: row.size_bytes,
    tablesCount: row.tables_count,
    tablesList: row.tables_list,
    status: row.status as Backup['status'],
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toBackupListItem(row: BackupRow): BackupListItem {
  return {
    backupId: row.backup_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    schemaName: row.schema_name,
    status: row.status as Backup['status'],
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

const VALID_BACKUP_SCOPE_CTE = `WITH schema_projects AS (
  SELECT p.schema_name, p.project_id, p.tenant_id
    FROM druvia_projects p
   WHERE p.schema_name IS NOT NULL
  UNION
  SELECT e.schema_name, p.project_id, p.tenant_id
    FROM druvia_project_environments e
    JOIN druvia_projects p ON p.project_id = e.project_id
),
unique_schema_scopes AS (
  SELECT schema_name,
         MIN(project_id) AS project_id,
         MIN(tenant_id) AS tenant_id
    FROM schema_projects
   GROUP BY schema_name
  HAVING COUNT(DISTINCT project_id) = 1
     AND COUNT(DISTINCT tenant_id) = 1
)`;

const BACKUP_LIST_COLUMNS = `b.backup_id, b.tenant_id, b.project_id, b.schema_name,
  b.status, b.size_bytes, b.created_at`;

const BACKUP_POSTGRES_CONTAINER = process.env.BACKUP_POSTGRES_CONTAINER || 'druvia-postgres';

async function runCommandForBuffer(
  spec: CommandSpec,
  commandLabel: 'pg_dump' | 'pg_restore',
  schemaName: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
    });

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => {
      logger.error(`${commandLabel} diagnostic output omitted`, { schemaName, command: spec.command });
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`${commandLabel} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

async function runCommandForRestore(
  spec: CommandSpec,
  schemaName: string,
  data: Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
    });

    child.stdin.write(data);
    child.stdin.end();

    child.stderr.on('data', () => {
      logger.error('pg_restore diagnostic output omitted', { schemaName, command: spec.command });
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function runPgDump(schemaName: string, preserveProtection = false): Promise<Buffer> {
  const directCommand = buildDirectPgDumpCommand(config.database, schemaName, preserveProtection);
  const dockerCommand = buildDockerPgDumpCommand(
    BACKUP_POSTGRES_CONTAINER,
    config.database,
    schemaName,
    preserveProtection,
  );

  return runWithEnoentFallback(
    () => runCommandForBuffer(directCommand, 'pg_dump', schemaName),
    () => runCommandForBuffer(dockerCommand, 'pg_dump', schemaName)
  );
}

async function runPgRestore(schemaName: string, data: Buffer, preserveProtection = false): Promise<void> {
  const directCommand = buildDirectPgRestoreCommand(config.database, schemaName, preserveProtection);
  const dockerCommand = buildDockerPgRestoreCommand(
    BACKUP_POSTGRES_CONTAINER,
    config.database,
    schemaName,
    preserveProtection,
  );

  return runWithEnoentFallback(
    () => runCommandForRestore(directCommand, schemaName, data),
    () => runCommandForRestore(dockerCommand, schemaName, data)
  );
}

// Get tables in schema
async function getSchemaTablesList(schemaName: string): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schemaName]
  );
  return rows.map(r => r.table_name);
}

async function guardForScope(projectId: string | null | undefined, schemaName: string): Promise<ProjectBackupGuard | undefined> {
  const guards = await loadProjectBackupGuards();
  const guard = guards.find(item => item.projectId === projectId || item.schemaName === schemaName);
  if (guard && (guard.schemaName !== schemaName || (projectId && guard.projectId !== projectId))) throw new ProjectBackupGuardError();
  return guard;
}

async function createProtectedBackup(guard: ProjectBackupGuard, tenantId: string, createdBy?: number): Promise<Backup> {
  // Hold one cross-process lock from insertion through storage completion. A delete/restore
  // cannot race an unfinished upload and leave an untracked object behind.
  if (getDefaultStorageAdapter().name !== 'local') throw new ProjectBackupGuardError();
  return new Promise<Backup>((resolve, reject) => {
    void withManagedBackupLock(guard, async client => {
      const backupId = generateBackupId();
      const storageKey = `backups/${tenantId}/${backupId}.dump`;
      const inserted = await client.query<BackupRow>(
        `INSERT INTO druvia_backups (backup_id,tenant_id,project_id,schema_name,storage_key,status,created_by)
         SELECT $1,$2,$3,$4,$5,'running',$6 WHERE EXISTS (
           SELECT 1 FROM druvia_projects WHERE project_id=$3 AND schema_name=$4 AND tenant_id=$2)
         RETURNING *`, [backupId, tenantId, guard.projectId, guard.schemaName, storageKey, createdBy ?? null]);
      const row = inserted.rows[0];
      if (!row) throw new ProjectBackupGuardError();
      resolve(toBackup(row));
      try {
        const tables = await getSchemaTablesList(guard.schemaName);
        const data = await runPgDump(guard.schemaName, true);
        await getDefaultStorageAdapter().upload(data, storageKey, { contentType: 'application/octet-stream', acl: 'private' });
        await client.query(`UPDATE druvia_backups SET status='completed',size_bytes=$2,tables_count=$3,tables_list=$4,completed_at=NOW() WHERE backup_id=$1`,
          [backupId, data.length, tables.length, JSON.stringify(tables)]);
      } catch {
        await client.query(`UPDATE druvia_backups SET status='failed',error_message='Protected backup failed' WHERE backup_id=$1`, [backupId]);
        logger.error('protected backup execution failed', { code: 'PROJECT_BACKUP_GUARD_REQUIRED' });
      }
    }).catch(reject);
  });
}

// Create backup
export async function createBackup(
  tenantId: string,
  schemaName: string,
  projectId?: string,
  createdBy?: number
): Promise<Backup> {
  const guard = await guardForScope(projectId, schemaName);
  if (guard) return createProtectedBackup(guard, tenantId, createdBy);
  const backupId = generateBackupId();
  const storage = getDefaultStorageAdapter();
  const storageKey = `backups/${tenantId}/${backupId}.dump`;

  // Create pending backup record
  const row = await queryOne<BackupRow>(
    `INSERT INTO druvia_backups
     (backup_id, tenant_id, project_id, schema_name, storage_key, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING *`,
    [backupId, tenantId, projectId || null, schemaName, storageKey, createdBy || null]
  );

  if (!row) {
    throw new Error('Failed to create backup record');
  }

  // Run backup asynchronously
  (async () => {
    try {
      // Update status to running
      await pool.query(
        'UPDATE druvia_backups SET status = $1 WHERE backup_id = $2',
        ['running', backupId]
      );

      // Get tables list
      const tablesList = await getSchemaTablesList(schemaName);

      // Run pg_dump
      const dumpData = await runPgDump(schemaName);

      // Upload to storage
      await storage.upload(dumpData, storageKey, {
        contentType: 'application/octet-stream',
      });

      // Update backup record
      await pool.query(
        `UPDATE druvia_backups
         SET status = 'completed', size_bytes = $1, tables_count = $2, tables_list = $3, completed_at = NOW()
         WHERE backup_id = $4`,
        [dumpData.length, tablesList.length, JSON.stringify(tablesList), backupId]
      );
    } catch (error) {
      const err = error as Error;
      logger.error('backup execution failed', { tenantId, projectId, schemaName, backupId }, err);
      await pool.query(
        `UPDATE druvia_backups SET status = 'failed', error_message = $1 WHERE backup_id = $2`,
        [err.message, backupId]
      );
    }
  })();

  return toBackup(row);
}

// Get backup by ID
export async function getBackupById(backupId: string): Promise<Backup | null> {
  const row = await queryOne<BackupRow>(
    'SELECT * FROM druvia_backups WHERE backup_id = $1',
    [backupId]
  );
  return row ? toBackup(row) : null;
}

// List backups for tenant
export async function listBackups(
  tenantId: string,
  limit = 50,
  offset = 0
): Promise<BackupListItem[]> {
  const rows = await query<BackupRow>(
    `${VALID_BACKUP_SCOPE_CTE}
     SELECT ${BACKUP_LIST_COLUMNS}
       FROM druvia_backups b
       JOIN unique_schema_scopes scope ON scope.schema_name = b.schema_name
      WHERE b.tenant_id = $1
        AND scope.tenant_id = b.tenant_id
        AND (b.project_id IS NULL OR b.project_id = scope.project_id)
     ORDER BY b.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows.map(toBackupListItem);
}

export async function listBackupsForProjects(
  tenantId: string,
  projectIds: string[],
  limit = 50,
  offset = 0,
): Promise<BackupListItem[]> {
  const rows = await query<BackupRow>(
    `${VALID_BACKUP_SCOPE_CTE}
     SELECT ${BACKUP_LIST_COLUMNS}
       FROM druvia_backups b
       JOIN unique_schema_scopes scope ON scope.schema_name = b.schema_name
      WHERE b.tenant_id = $1
        AND scope.tenant_id = b.tenant_id
        AND b.project_id = scope.project_id
        AND b.project_id = ANY($2::text[])
      ORDER BY b.created_at DESC
      LIMIT $3 OFFSET $4`,
    [tenantId, projectIds, limit, offset],
  );
  return rows.map(toBackupListItem);
}

// Delete backup
export async function deleteBackup(backupId: string): Promise<boolean> {
  const backup = await getBackupById(backupId);
  if (!backup) return false;
  const guard = await guardForScope(backup.projectId, backup.schemaName);
  if (guard) return withManagedBackupLock(guard, async client => {
    const current = await getBackupById(backupId);
    if (!current) return false;
    if (current.schemaName !== guard.schemaName || (current.projectId && current.projectId !== guard.projectId)) throw new ProjectBackupGuardError();
    await deleteManagedBackupObject(client, { backup_id: current.backupId, tenant_id: current.tenantId, project_id: current.projectId, schema_name: current.schemaName, storage_key: current.storageKey });
    return true;
  });

  // Delete from storage
  const storage = getDefaultStorageAdapter();
  try {
    await storage.delete(backup.storageKey);
  } catch {
    // Ignore storage deletion errors
  }

  // Delete from database
  const rows = await query<{ backup_id: string }>(
    'DELETE FROM druvia_backups WHERE backup_id = $1 RETURNING backup_id',
    [backupId]
  );

  return rows.length > 0;
}

// Restore backup
export async function restoreBackup(backupId: string): Promise<void> {
  const backup = await getBackupById(backupId);
  if (!backup) {
    throw new Error('Backup not found');
  }

  if (backup.status !== 'completed') {
    throw new Error('Backup is not completed');
  }

  const legacyScope = backup.projectId
    ? null
    : await queryOne<{ project_id: string }>(
      `${VALID_BACKUP_SCOPE_CTE}
       SELECT project_id
       FROM unique_schema_scopes
       WHERE schema_name = $1 AND tenant_id = $2`,
      [backup.schemaName, backup.tenantId],
    );
  const projectId = backup.projectId ?? legacyScope?.project_id;
  if (!projectId) throw new Error('BACKUP_SCOPE_MISMATCH');

  const guard = await guardForScope(projectId, backup.schemaName);
  const restore = async (lockClient: import('pg').PoolClient) => withProjectAuthProjectLock(
    lockClient,
    projectId,
    async () => {
      const current = guard ? await getBackupById(backupId) : backup;
      if (!current || current.status !== 'completed' || current.schemaName !== backup.schemaName
        || current.tenantId !== backup.tenantId || current.storageKey !== backup.storageKey
        || current.projectId !== backup.projectId) throw new ProjectBackupGuardError();
      if (guard && current.createdAt.getTime() <= Date.now() - guard.retentionDays * 86400000) throw new ProjectBackupGuardError();
      await beginProjectRestoreGate(projectId, backup.backupId);
      try {
        if (guard) await guardTransaction(lockClient, () => executeProjectBackupGuard(lockClient, guard, 'prepare'));
        await restoreBackupUnlocked(current, Boolean(guard));
        await replayProjectAccountDeletionFences(projectId, backup.backupId, guard ? {
          beforeReplay: async client => { await executeProjectBackupGuard(client, guard, 'beginReplay'); },
          afterReplay: async client => { await executeProjectBackupGuard(client, guard, 'replay'); },
        } : undefined);
      } catch (error) {
        await markProjectRestoreRecoveryRequired(
          projectId,
          backup.backupId,
          projectRestoreRecoveryReason(error),
        );
        throw error;
      }
    },
  );
  await withProjectDataAccessMutationLock(projectId, async client => {
    if (guard) return withManagedBackupLock(guard, () => restore(client));
    return restore(client);
  }, { globalMode: 'exclusive' });
}

export async function restoreBackupUnlocked(backup: Backup, preserveProtection = false): Promise<void> {
  // Download from storage
  const storage = getDefaultStorageAdapter();
  let data: Buffer;

  // For local storage, we can read directly using the LocalAdapter's read method
  if (storage.name === 'local' && 'read' in storage) {
    data = await (storage as unknown as { read: (path: string) => Promise<Buffer> }).read(backup.storageKey);
  } else {
    // For cloud storage, download via signed URL
    const url = await storage.getSignedUrl(backup.storageKey);
    const response = await fetch(url);
    data = Buffer.from(await response.arrayBuffer());
  }

  await runPgRestore(backup.schemaName, data, preserveProtection);
}

// Get download URL for backup
export async function getBackupDownloadUrl(backupId: string): Promise<string | null> {
  const backup = await getBackupById(backupId);
  if (!backup || backup.status !== 'completed') return null;

  const guard = await guardForScope(backup.projectId, backup.schemaName);
  const secondsRemaining = guard ? Math.floor((backup.createdAt.getTime() + guard.retentionDays * 86400000 - Date.now()) / 1000) : 3600;
  if (secondsRemaining <= 0) return null;
  const storage = getDefaultStorageAdapter();
  return storage.getSignedUrl(backup.storageKey, Math.min(3600, secondsRemaining));
}

// List all backups (admin) with optional filters
export async function listAllBackups(
  tenantId?: string,
  projectId?: string,
  limit = 50,
  offset = 0
): Promise<{ backups: Backup[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (tenantId) {
    conditions.push(`tenant_id = $${paramIndex++}`);
    params.push(tenantId);
  }
  if (projectId) {
    conditions.push(`project_id = $${paramIndex++}`);
    params.push(projectId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit, offset);

  const rows = await query<BackupRow>(
    `SELECT * FROM druvia_backups
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  const countParams = params.slice(0, -2);
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM druvia_backups ${whereClause}`,
    countParams
  );

  return {
    backups: rows.map(toBackup),
    total: parseInt(countResult?.count || '0', 10),
  };
}
