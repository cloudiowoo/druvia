import { spawn } from 'child_process';
import { query, queryOne, pool } from '../../db/index.js';
import { generateBackupId } from '@druvia/shared';
import { getDefaultStorageAdapter } from '../../adapters/storage/index.js';
import { config } from '../../config/index.js';

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

// Run pg_dump command via Docker
async function runPgDump(schemaName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    // Use docker exec to run pg_dump inside the postgres container
    const pgDump = spawn('docker', [
      'exec',
      'druvia-postgres',
      'pg_dump',
      '-U', config.database.user,
      '-d', config.database.database,
      '-n', schemaName,
      '-F', 'c',  // Custom format (compressed)
      '--no-owner',
      '--no-acl',
    ]);

    pgDump.stdout.on('data', (chunk) => chunks.push(chunk));
    pgDump.stderr.on('data', (data) => console.error(`pg_dump stderr: ${data}`));

    pgDump.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`pg_dump exited with code ${code}`));
      }
    });

    pgDump.on('error', reject);
  });
}

// Run pg_restore command via Docker
async function runPgRestore(schemaName: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use docker exec to run pg_restore inside the postgres container
    const pgRestore = spawn('docker', [
      'exec',
      '-i',  // Interactive mode to accept stdin
      'druvia-postgres',
      'pg_restore',
      '-U', config.database.user,
      '-d', config.database.database,
      '-n', schemaName,
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
    ]);

    pgRestore.stdin.write(data);
    pgRestore.stdin.end();

    pgRestore.stderr.on('data', (data) => console.error(`pg_restore stderr: ${data}`));

    pgRestore.on('close', (code) => {
      // pg_restore may return non-zero even on success with warnings
      resolve();
    });

    pgRestore.on('error', reject);
  });
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
): Promise<Backup[]> {
  const rows = await query<BackupRow>(
    `SELECT * FROM druvia_backups
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows.map(toBackup);
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
