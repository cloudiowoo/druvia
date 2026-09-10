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
    child.stderr.on('data', (data) => {
      logger.error(`${commandLabel} stderr`, { schemaName, command: spec.command }, String(data));
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

    child.stderr.on('data', (stderr) => {
      logger.error('pg_restore stderr', { schemaName, command: spec.command }, String(stderr));
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function runPgDump(schemaName: string): Promise<Buffer> {
  const directCommand = buildDirectPgDumpCommand(config.database, schemaName);
  const dockerCommand = buildDockerPgDumpCommand(
    BACKUP_POSTGRES_CONTAINER,
    config.database,
    schemaName
  );

  return runWithEnoentFallback(
    () => runCommandForBuffer(directCommand, 'pg_dump', schemaName),
    () => runCommandForBuffer(dockerCommand, 'pg_dump', schemaName)
  );
}

async function runPgRestore(schemaName: string, data: Buffer): Promise<void> {
  const directCommand = buildDirectPgRestoreCommand(config.database, schemaName);
  const dockerCommand = buildDockerPgRestoreCommand(
    BACKUP_POSTGRES_CONTAINER,
    config.database,
    schemaName
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

// Create backup
export async function createBackup(
  tenantId: string,
  schemaName: string,
  projectId?: string,
  createdBy?: number
): Promise<Backup> {
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

  const restore = async (lockClient: import('pg').PoolClient) => withProjectAuthProjectLock(
    lockClient,
    projectId,
    async () => {
      await beginProjectRestoreGate(projectId, backup.backupId);
      try {
        await restoreBackupUnlocked(backup);
        await replayProjectAccountDeletionFences(projectId, backup.backupId);
      } catch (error) {
        await markProjectRestoreRecoveryRequired(
          projectId,
          backup.backupId,
          'ACCOUNT_DELETION_FENCE_REPLAY_REQUIRED',
        );
        throw error;
      }
    },
  );
  await withProjectDataAccessMutationLock(projectId, restore, { globalMode: 'exclusive' });
}

export async function restoreBackupUnlocked(backup: Backup): Promise<void> {
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

  await runPgRestore(backup.schemaName, data);
}

// Get download URL for backup
export async function getBackupDownloadUrl(backupId: string): Promise<string | null> {
  const backup = await getBackupById(backupId);
  if (!backup || backup.status !== 'completed') return null;

  const storage = getDefaultStorageAdapter();
  return storage.getSignedUrl(backup.storageKey, 3600);
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
