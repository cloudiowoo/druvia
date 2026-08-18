import type { ProjectDataAccessMode } from '@druvia/shared'
import { queryOne } from '../../db/index.js'
import type {
  DataAccessMigrationPhase,
  DataAccessMigrationStatus,
  ProjectDataAccessMigrationPlan,
  ProjectDataAccessMigrationSnapshot,
} from './data-access-migration.types.js'

interface MigrationRow {
  migration_id: string
  project_id: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  source_snapshot: ProjectDataAccessMigrationSnapshot
  migration_plan: ProjectDataAccessMigrationPlan
  source_digest: string
  applied_snapshot: ProjectDataAccessMigrationSnapshot | null
  applied_digest: string | null
  rollback_preview_digest: string | null
  recovery_target: 'source' | 'applied' | null
  has_destructive_changes: boolean
  created_by: string
  error_code: string | null
  error_message: string | null
  created_at: Date
  started_at: Date | null
  applied_at: Date | null
  completed_at: Date | null
  updated_at: Date
}

export interface DataAccessMigrationRecord {
  migrationId: string
  projectId: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  sourceSnapshot: ProjectDataAccessMigrationSnapshot
  migrationPlan: ProjectDataAccessMigrationPlan
  sourceDigest: string
  appliedSnapshot: ProjectDataAccessMigrationSnapshot | null
  appliedDigest: string | null
  rollbackPreviewDigest: string | null
  recoveryTarget: 'source' | 'applied' | null
  hasDestructiveChanges: boolean
  createdBy: string
  error: { code: string; message: string } | null
  createdAt: Date
  startedAt: Date | null
  appliedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

export interface CreateMigrationPreviewInput {
  migrationId: string
  projectId: string
  sourceSnapshot: ProjectDataAccessMigrationSnapshot
  migrationPlan: ProjectDataAccessMigrationPlan
  sourceDigest: string
  hasDestructiveChanges: boolean
  createdBy: string
}

export class DataAccessMigrationTransitionError extends Error {}

export async function createMigrationPreview(
  input: CreateMigrationPreviewInput
): Promise<DataAccessMigrationRecord> {
  const row = await queryOne<MigrationRow>(
    `INSERT INTO druvia_data_access_migrations (
       migration_id, project_id, status, phase, source_snapshot, migration_plan, source_digest,
       has_destructive_changes, created_by
     ) VALUES ($1, $2, 'preview_ready', 'preview', $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [
      input.migrationId,
      input.projectId,
      JSON.stringify(input.sourceSnapshot),
      JSON.stringify(input.migrationPlan),
      input.sourceDigest,
      input.hasDestructiveChanges,
      input.createdBy,
    ]
  )
  if (!row) throw new Error('Failed to create data access migration preview')
  return toRecord(row)
}

export async function getLatestProjectMigration(
  projectId: string
): Promise<DataAccessMigrationRecord | null> {
  const row = await queryOne<MigrationRow>(
    `SELECT * FROM druvia_data_access_migrations
     WHERE project_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [projectId]
  )
  return row ? toRecord(row) : null
}

export async function getProjectMigration(
  projectId: string,
  migrationId: string
): Promise<DataAccessMigrationRecord | null> {
  const row = await queryOne<MigrationRow>(
    `SELECT * FROM druvia_data_access_migrations
     WHERE project_id = $1 AND migration_id = $2`,
    [projectId, migrationId]
  )
  return row ? toRecord(row) : null
}

export interface MigrationTransitionPatch {
  status?: DataAccessMigrationStatus
  phase?: DataAccessMigrationPhase
  recoveryTarget?: 'source' | 'applied' | null
  appliedSnapshot?: ProjectDataAccessMigrationSnapshot
  appliedDigest?: string
  rollbackPreviewDigest?: string | null
  error?: { code: string; message: string } | null
  startedAt?: Date
  appliedAt?: Date
  completedAt?: Date
}

export async function transitionMigration(
  migrationId: string,
  expectedStatuses: DataAccessMigrationStatus[],
  patch: MigrationTransitionPatch
): Promise<DataAccessMigrationRecord> {
  if (expectedStatuses.length === 0) throw new Error('Expected migration status is required')
  const updates: string[] = []
  const values: unknown[] = [migrationId, expectedStatuses]
  const add = (column: string, value: unknown, cast = '') => {
    values.push(value)
    updates.push(`${column} = $${values.length}${cast}`)
  }
  if (patch.status !== undefined) add('status', patch.status)
  if (patch.phase !== undefined) add('phase', patch.phase)
  if (patch.recoveryTarget !== undefined) add('recovery_target', patch.recoveryTarget)
  if (patch.appliedSnapshot !== undefined) add('applied_snapshot', JSON.stringify(patch.appliedSnapshot), '::jsonb')
  if (patch.appliedDigest !== undefined) add('applied_digest', patch.appliedDigest)
  if (patch.rollbackPreviewDigest !== undefined) add('rollback_preview_digest', patch.rollbackPreviewDigest)
  if (patch.error !== undefined) {
    add('error_code', patch.error?.code ?? null)
    add('error_message', patch.error?.message ?? null)
  }
  if (patch.startedAt !== undefined) add('started_at', patch.startedAt)
  if (patch.appliedAt !== undefined) add('applied_at', patch.appliedAt)
  if (patch.completedAt !== undefined) add('completed_at', patch.completedAt)
  if (updates.length === 0) throw new Error('Migration transition patch is empty')

  const row = await queryOne<MigrationRow>(
    `UPDATE druvia_data_access_migrations
     SET ${updates.join(', ')}
     WHERE migration_id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    values
  )
  if (!row) throw new DataAccessMigrationTransitionError('Migration state changed before the requested transition')
  return toRecord(row)
}

export async function setProjectDataAccessMode(
  projectId: string,
  expectedMode: ProjectDataAccessMode,
  nextMode: ProjectDataAccessMode
): Promise<boolean> {
  const row = await queryOne<{ project_id: string }>(
    `UPDATE druvia_projects
     SET data_access_mode = $2, updated_at = NOW()
     WHERE project_id = $1 AND data_access_mode = $3
     RETURNING project_id`,
    [projectId, nextMode, expectedMode]
  )
  return !!row
}

function toRecord(row: MigrationRow): DataAccessMigrationRecord {
  return {
    migrationId: row.migration_id,
    projectId: row.project_id,
    status: row.status,
    phase: row.phase,
    sourceSnapshot: row.source_snapshot,
    migrationPlan: row.migration_plan,
    sourceDigest: row.source_digest,
    appliedSnapshot: row.applied_snapshot,
    appliedDigest: row.applied_digest,
    rollbackPreviewDigest: row.rollback_preview_digest,
    recoveryTarget: row.recovery_target,
    hasDestructiveChanges: row.has_destructive_changes,
    createdBy: row.created_by,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'Migration failed' } : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    appliedAt: row.applied_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}
