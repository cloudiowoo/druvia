import type { PoolClient } from 'pg'
import { queryOne } from '../../db/index.js'
import type {
  AuthorizationProjectionContract,
  AuthorizationProjectionDependencySnapshot,
} from './data-access-authorization-projection.js'

export type ProjectionOperationStatus =
  | 'preview_ready' | 'applying' | 'recovering' | 'completed'
  | 'failed' | 'recovery_required' | 'superseded'

export type ProjectionOperationPhase =
  | 'preview' | 'source_check' | 'apply_metadata' | 'verify_target'
  | 'persist_baselines' | 'inspect_recovery' | 'fail_closed'
  | 'verify_fail_closed' | 'completed'

interface ProjectionOperationRow {
  operation_id: string
  project_id: string
  schema_name: string
  status: ProjectionOperationStatus
  phase: ProjectionOperationPhase
  contract: AuthorizationProjectionContract
  baseline_revisions: Record<string, string>
  source_metadata: Record<string, unknown>
  target_metadata: Record<string, unknown>
  dependency_snapshot: AuthorizationProjectionDependencySnapshot
  dependency_digest: string
  source_digest: string
  target_digest: string
  source_resource_version: string
  target_resource_version: string | null
  request_digest: string
  writer_epoch: string | null
  write_deadline_at: Date | null
  created_by: string
  error_code: string | null
  error_message: string | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  updated_at: Date
}

export interface ProjectionOperationRecord {
  operationId: string
  projectId: string
  schemaName: string
  status: ProjectionOperationStatus
  phase: ProjectionOperationPhase
  contract: AuthorizationProjectionContract
  baselineRevisions: Record<string, string>
  sourceMetadata: Record<string, unknown>
  targetMetadata: Record<string, unknown>
  dependencySnapshot: AuthorizationProjectionDependencySnapshot
  dependencyDigest: string
  sourceDigest: string
  targetDigest: string
  sourceResourceVersion: bigint
  targetResourceVersion: bigint | null
  requestDigest: string
  writerEpoch: string | null
  writeDeadlineAt: Date | null
  createdBy: string
  error: { code: string; message: string } | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

interface Queryable { query: PoolClient['query'] }

export interface CreateProjectionOperationInput {
  operationId: string
  projectId: string
  schemaName: string
  contract: AuthorizationProjectionContract
  baselineRevisions: Record<string, string>
  sourceMetadata: Record<string, unknown>
  targetMetadata: Record<string, unknown>
  dependencySnapshot: AuthorizationProjectionDependencySnapshot
  dependencyDigest: string
  sourceDigest: string
  targetDigest: string
  sourceResourceVersion: bigint
  requestDigest: string
  createdBy: string
}

export async function createProjectionOperation(
  client: Queryable,
  input: CreateProjectionOperationInput
): Promise<ProjectionOperationRecord> {
  const result = await client.query<ProjectionOperationRow>(
    `INSERT INTO druvia_data_access_projection_operations (
       operation_id, project_id, schema_name, status, phase, contract, baseline_revisions,
       source_metadata, target_metadata, dependency_snapshot, dependency_digest,
       source_digest, target_digest, source_resource_version, request_digest, created_by
     ) VALUES (
       $1, $2, $3, 'preview_ready', 'preview', $4::jsonb, $5::jsonb,
       $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14
     ) RETURNING *`,
    [
      input.operationId, input.projectId, input.schemaName,
      JSON.stringify(input.contract), JSON.stringify(input.baselineRevisions),
      JSON.stringify(input.sourceMetadata), JSON.stringify(input.targetMetadata),
      JSON.stringify(input.dependencySnapshot), input.dependencyDigest,
      input.sourceDigest, input.targetDigest, input.sourceResourceVersion.toString(),
      input.requestDigest, input.createdBy,
    ]
  )
  if (!result.rows[0]) throw new Error('Failed to create projection operation')
  return toRecord(result.rows[0])
}

export async function getProjectionOperation(
  projectId: string,
  operationId: string
): Promise<ProjectionOperationRecord | null> {
  const row = await queryOne<ProjectionOperationRow>(
    `SELECT * FROM druvia_data_access_projection_operations
     WHERE project_id = $1 AND operation_id = $2`,
    [projectId, operationId]
  )
  return row ? toRecord(row) : null
}

export async function getProjectionOperationWithClient(
  client: Queryable,
  projectId: string,
  operationId: string
): Promise<ProjectionOperationRecord | null> {
  const result = await client.query<ProjectionOperationRow>(
    `SELECT * FROM druvia_data_access_projection_operations
     WHERE project_id = $1 AND operation_id = $2`,
    [projectId, operationId]
  )
  return result.rows[0] ? toRecord(result.rows[0]) : null
}

export async function getEffectiveFailClosedProjectionOperationWithClient(
  client: Queryable,
  projectId: string
): Promise<ProjectionOperationRecord | null> {
  const result = await client.query<ProjectionOperationRow>(
    `SELECT failed.* FROM druvia_data_access_projection_operations AS failed
     WHERE failed.project_id = $1
       AND failed.status = 'failed'
       AND failed.error_code = $2
       AND NOT EXISTS (
         SELECT 1 FROM druvia_data_access_projection_operations AS newer
         WHERE newer.project_id = failed.project_id
           AND newer.status = 'completed'
           AND (newer.created_at, newer.id) > (failed.created_at, failed.id)
       )
     ORDER BY failed.created_at DESC, failed.id DESC LIMIT 1`,
    [projectId, 'DATA_ACCESS_PROJECTION_FAILED_CLOSED']
  )
  return result.rows[0] ? toRecord(result.rows[0]) : null
}

export async function claimLatestCompletedProjectionRecovery(
  client: Queryable,
  projectId: string,
  operationId: string,
  writerEpoch: string,
  writeDeadlineAt: Date
): Promise<ProjectionOperationRecord | null> {
  await client.query('BEGIN')
  try {
    await client.query(
      `UPDATE druvia_data_access_projection_operations
       SET status = 'superseded', phase = 'completed', completed_at = NOW()
       WHERE project_id = $1 AND operation_id <> $2 AND status = 'preview_ready'`,
      [projectId, operationId]
    )
    const result = await client.query<ProjectionOperationRow>(
      `UPDATE druvia_data_access_projection_operations AS current
       SET status = 'recovering', phase = 'inspect_recovery', writer_epoch = $3,
           write_deadline_at = $4, completed_at = NULL
       WHERE current.project_id = $1 AND current.operation_id = $2
         AND current.status = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM druvia_data_access_projection_operations AS newer
           WHERE newer.project_id = current.project_id
             AND newer.target_resource_version IS NOT NULL
             AND (newer.created_at, newer.id) > (current.created_at, current.id)
         )
       RETURNING current.*`,
      [projectId, operationId, writerEpoch, writeDeadlineAt]
    )
    if (!result.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query('COMMIT')
    return toRecord(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

export async function getActiveProjectionOperation(
  projectId: string
): Promise<ProjectionOperationRecord | null> {
  const row = await queryOne<ProjectionOperationRow>(
    `SELECT * FROM druvia_data_access_projection_operations
     WHERE project_id = $1
     ORDER BY CASE
       WHEN status IN ('applying', 'recovering', 'recovery_required') THEN 0
       WHEN target_resource_version IS NOT NULL
         OR (status = 'failed' AND error_code = 'DATA_ACCESS_PROJECTION_FAILED_CLOSED') THEN 1
       ELSE 2
     END,
     created_at DESC, id DESC LIMIT 1`,
    [projectId]
  )
  return row ? toRecord(row) : null
}

export async function supersedeProjectionPreviews(
  client: Queryable,
  projectId: string
): Promise<void> {
  await client.query(
    `UPDATE druvia_data_access_projection_operations
     SET status = 'superseded', phase = 'completed', completed_at = NOW()
     WHERE project_id = $1 AND status = 'preview_ready'`,
    [projectId]
  )
}

export interface ProjectionOperationTransitionPatch {
  status?: ProjectionOperationStatus
  phase?: ProjectionOperationPhase
  targetResourceVersion?: bigint | null
  writerEpoch?: string | null
  writeDeadlineAt?: Date | null
  error?: { code: string; message: string } | null
  startedAt?: Date | null
  completedAt?: Date | null
}

export class ProjectionOperationTransitionError extends Error {}
export class ProjectionOperationWriterLeaseError extends Error {}

export async function transitionProjectionOperation(
  client: Queryable,
  operationId: string,
  expectedStatuses: ProjectionOperationStatus[],
  patch: ProjectionOperationTransitionPatch
): Promise<ProjectionOperationRecord> {
  if (expectedStatuses.length === 0) throw new Error('Expected projection operation status is required')
  const updates: string[] = []
  const values: unknown[] = [operationId, expectedStatuses]
  const add = (column: string, value: unknown) => {
    values.push(value)
    updates.push(`${column} = $${values.length}`)
  }
  if (patch.status !== undefined) add('status', patch.status)
  if (patch.phase !== undefined) add('phase', patch.phase)
  if (patch.targetResourceVersion !== undefined) {
    add('target_resource_version', patch.targetResourceVersion?.toString() ?? null)
  }
  if (patch.writerEpoch !== undefined) add('writer_epoch', patch.writerEpoch)
  if (patch.writeDeadlineAt !== undefined) add('write_deadline_at', patch.writeDeadlineAt)
  if (patch.error !== undefined) {
    add('error_code', patch.error?.code ?? null)
    add('error_message', patch.error?.message ?? null)
  }
  if (patch.startedAt !== undefined) add('started_at', patch.startedAt)
  if (patch.completedAt !== undefined) add('completed_at', patch.completedAt)
  if (updates.length === 0) throw new Error('Projection operation transition patch is empty')
  const result = await client.query<ProjectionOperationRow>(
    `UPDATE druvia_data_access_projection_operations SET ${updates.join(', ')}
     WHERE operation_id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    values
  )
  if (!result.rows[0]) throw new ProjectionOperationTransitionError('Projection operation changed')
  return toRecord(result.rows[0])
}

export async function renewProjectionOperationWriterLease(
  client: Queryable,
  operationId: string,
  status: 'applying' | 'recovering',
  writerEpoch: string,
  deadline: Date
): Promise<void> {
  const result = await client.query<ProjectionOperationRow>(
    `UPDATE druvia_data_access_projection_operations
     SET write_deadline_at = $4
     WHERE operation_id = $1 AND status = $2 AND writer_epoch = $3
       AND write_deadline_at IS NOT NULL AND write_deadline_at > NOW()
     RETURNING *`,
    [operationId, status, writerEpoch, deadline]
  )
  if (!result.rows[0]) throw new ProjectionOperationWriterLeaseError('Projection writer lease expired')
}

function toRecord(row: ProjectionOperationRow): ProjectionOperationRecord {
  return {
    operationId: row.operation_id, projectId: row.project_id, schemaName: row.schema_name,
    status: row.status, phase: row.phase, contract: row.contract,
    baselineRevisions: row.baseline_revisions, sourceMetadata: row.source_metadata,
    targetMetadata: row.target_metadata, dependencySnapshot: row.dependency_snapshot,
    dependencyDigest: row.dependency_digest, sourceDigest: row.source_digest,
    targetDigest: row.target_digest, sourceResourceVersion: BigInt(row.source_resource_version),
    targetResourceVersion: row.target_resource_version === null ? null : BigInt(row.target_resource_version),
    requestDigest: row.request_digest, writerEpoch: row.writer_epoch,
    writeDeadlineAt: row.write_deadline_at, createdBy: row.created_by,
    error: row.error_code
      ? { code: row.error_code, message: row.error_message ?? 'Projection operation failed' }
      : null,
    createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  }
}
