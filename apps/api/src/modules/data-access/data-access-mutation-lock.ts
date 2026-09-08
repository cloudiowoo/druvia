import type { PoolClient } from 'pg'
import { getClient, queryOne } from '../../db/index.js'

export const DATA_ACCESS_GLOBAL_LOCK_ID = 'data-access-mutation:global'
const RECOVERY_ERRORS = [
  'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
  'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED',
]

export class DataAccessMutationLockedError extends Error {
  readonly code = 'DATA_ACCESS_MIGRATION_IN_PROGRESS'
}

export function isDataAccessMigrationDeleteGuardError(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string }
  return value?.code === '55006'
    && [
      'druvia_data_access_migrations_inflight_delete_guard',
      'druvia_data_access_policy_operations_inflight_delete_guard',
    ].includes(value.constraint ?? '')
}

export interface DataAccessMutationLockOptions {
  globalMode?: 'shared' | 'exclusive'
  purpose?: 'ordinary' | 'migration' | 'policy_operation' | 'table_delete' | 'table_delete_recovery'
  migrationId?: string
  operationId?: string
}

export function projectDataAccessLockId(projectId: string): string {
  if (!projectId.trim()) throw new Error('Project ID is required')
  return `data-access-migration:${projectId}`
}

export async function withProjectDataAccessMutationLock<T>(
  projectId: string,
  callback: (client: PoolClient) => Promise<T>,
  options: DataAccessMutationLockOptions = {}
): Promise<T> {
  const globalMode = options.globalMode ?? 'shared'
  const purpose = options.purpose ?? 'ordinary'
  if (purpose === 'migration' && (!options.migrationId || !options.operationId)) {
    throw new Error('Migration ID and operation ID are required for migration lock context')
  }
  if (purpose === 'policy_operation' && !options.operationId) {
    throw new Error('Operation ID is required for policy operation lock context')
  }
  if ((purpose === 'table_delete' || purpose === 'table_delete_recovery') && !options.operationId) {
    throw new Error('Operation ID is required for table deletion lock context')
  }

  const client = await getClient()
  let globalAcquired = false
  let projectAcquired = false
  try {
    globalAcquired = await tryLock(client, DATA_ACCESS_GLOBAL_LOCK_ID, globalMode === 'shared')
    if (!globalAcquired) throw new DataAccessMutationLockedError('A deployment-wide data change is in progress')

    projectAcquired = await tryLock(client, projectDataAccessLockId(projectId), false)
    if (!projectAcquired) throw new DataAccessMutationLockedError('A project data change is in progress')

    if (await hasPersistedDataAccessBlock(
      client,
      projectId,
      globalMode,
      purpose,
      options.operationId,
      options.migrationId
    )) {
      throw new DataAccessMutationLockedError('Project data access migration requires completion or recovery')
    }

    if (purpose !== 'policy_operation') {
      await supersedePolicyOperationPreviews(client, projectId, globalMode)
    }

    return await callback(client)
  } finally {
    try {
      if (projectAcquired) await unlock(client, projectDataAccessLockId(projectId), false)
    } finally {
      try {
        if (globalAcquired) await unlock(client, DATA_ACCESS_GLOBAL_LOCK_ID, globalMode === 'shared')
      } finally {
        client.release()
      }
    }
  }
}

export async function resolveProjectIdForDataSchema(schemaName: string): Promise<string | null> {
  const row = await queryOne<{ project_id: string }>(
    `SELECT project_id
     FROM druvia_projects
     WHERE schema_name = $1
     UNION ALL
     SELECT project_id
     FROM druvia_project_environments
     WHERE schema_name = $1
     LIMIT 1`,
    [schemaName]
  )
  return row?.project_id ?? null
}

export async function withSchemaDataAccessMutationLock<T>(
  schemaName: string,
  callback: (projectId: string | null, client: PoolClient) => Promise<T>,
  options: DataAccessMutationLockOptions = {}
): Promise<T> {
  const projectId = await resolveProjectIdForDataSchema(schemaName)
  const lockScope = projectId ?? `unresolved-schema:${schemaName}`
  return withProjectDataAccessMutationLock(
    lockScope,
    (client) => callback(projectId, client),
    options
  )
}

async function supersedePolicyOperationPreviews(
  client: PoolClient,
  projectId: string,
  globalMode: 'shared' | 'exclusive'
): Promise<void> {
  const scope = globalMode === 'exclusive' ? 'TRUE' : 'project_id = $1'
  await client.query(
    `UPDATE druvia_data_access_policy_operations
     SET status = 'superseded', phase = 'completed', completed_at = NOW()
     WHERE (${scope}) AND status = 'preview_ready'`,
    globalMode === 'exclusive' ? [] : [projectId]
  )
}

async function tryLock(client: PoolClient, identity: string, shared: boolean): Promise<boolean> {
  const fn = shared ? 'pg_try_advisory_lock_shared' : 'pg_try_advisory_lock'
  const result = await client.query<{ acquired: boolean }>(
    `SELECT ${fn}(hashtextextended($1, 0)) AS acquired`,
    [identity]
  )
  return result.rows[0]?.acquired === true
}

async function unlock(client: PoolClient, identity: string, shared: boolean): Promise<void> {
  const fn = shared ? 'pg_advisory_unlock_shared' : 'pg_advisory_unlock'
  await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [identity])
}

async function hasPersistedDataAccessBlock(
  client: PoolClient,
  projectId: string,
  globalMode: 'shared' | 'exclusive',
  purpose: 'ordinary' | 'migration' | 'policy_operation' | 'table_delete' | 'table_delete_recovery',
  operationId?: string,
  migrationId?: string
): Promise<boolean> {
  const tableScopedDelete = purpose === 'table_delete' || purpose === 'table_delete_recovery'
  const scope = globalMode === 'exclusive' && !tableScopedDelete
    ? '$1::text IS NOT NULL'
    : 'project_id = $1'
  const migrationExcluded = purpose === 'migration'
    ? 'AND migration_id <> $2'
    : 'AND $2::text IS NOT NULL'
  const policyStatuses = purpose === 'migration'
    ? "('preview_ready', 'applying', 'recovering', 'recovery_required')"
    : "('applying', 'recovering', 'recovery_required')"
  const policyExcluded = purpose === 'policy_operation'
    ? 'AND operation_id <> $3'
    : 'AND $3::text IS NOT NULL'
  const tableDeletionBlocks = purpose !== 'table_delete_recovery'
  const tableDeletionScope = 'lock_scope = $1'
  const result = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM druvia_data_access_migrations
       WHERE (${scope})
         ${migrationExcluded}
         AND (
           status IN ('applying', 'rolling_back')
           OR (status = 'failed' AND error_code = ANY($4::text[]))
         )
       UNION ALL
       SELECT 1
       FROM druvia_data_access_policy_operations
       WHERE (${scope})
         ${policyExcluded}
         AND status IN ${policyStatuses}
       UNION ALL
       SELECT 1
       FROM druvia_table_deletion_outbox
       WHERE (${tableDeletionScope})
         AND $5::boolean
     ) AS blocked`,
    [projectId, migrationId ?? '', operationId ?? '', RECOVERY_ERRORS, tableDeletionBlocks]
  )
  return result.rows[0]?.blocked === true
}
