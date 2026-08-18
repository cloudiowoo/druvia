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
    && value.constraint === 'druvia_data_access_migrations_inflight_delete_guard'
}

export interface DataAccessMutationLockOptions {
  globalMode?: 'shared' | 'exclusive'
  purpose?: 'ordinary' | 'migration'
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

  const client = await getClient()
  let globalAcquired = false
  let projectAcquired = false
  try {
    globalAcquired = await tryLock(client, DATA_ACCESS_GLOBAL_LOCK_ID, globalMode === 'shared')
    if (!globalAcquired) throw new DataAccessMutationLockedError('A deployment-wide data change is in progress')

    projectAcquired = await tryLock(client, projectDataAccessLockId(projectId), false)
    if (!projectAcquired) throw new DataAccessMutationLockedError('A project data change is in progress')

    if (purpose === 'ordinary' && await hasPersistedMigrationBlock(client, projectId, globalMode)) {
      throw new DataAccessMutationLockedError('Project data access migration requires completion or recovery')
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
  callback: (projectId: string | null) => Promise<T>,
  options: DataAccessMutationLockOptions = {}
): Promise<T> {
  const projectId = await resolveProjectIdForDataSchema(schemaName)
  const lockScope = projectId ?? `unresolved-schema:${schemaName}`
  return withProjectDataAccessMutationLock(lockScope, () => callback(projectId), options)
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

async function hasPersistedMigrationBlock(
  client: PoolClient,
  projectId: string,
  globalMode: 'shared' | 'exclusive'
): Promise<boolean> {
  const scope = globalMode === 'exclusive'
    ? 'TRUE'
    : 'project_id = $1'
  const params = globalMode === 'exclusive' ? [] : [projectId]
  const result = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM druvia_data_access_migrations
       WHERE (${scope})
         AND (
           status IN ('applying', 'rolling_back')
           OR (status = 'failed' AND error_code = ANY($${params.length + 1}::text[]))
         )
     ) AS blocked`,
    [...params, RECOVERY_ERRORS]
  )
  return result.rows[0]?.blocked === true
}
