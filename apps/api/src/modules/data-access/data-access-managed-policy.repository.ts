import type { PoolClient } from 'pg'
import { query, queryOne } from '../../db/index.js'
import type {
  DataAccessColumnCapabilities,
  DataAccessColumnGrants,
  DataAccessPolicyOperationKind,
  DataAccessPolicyOperationStatus,
  MaterializedDataPermission,
  TableDataAccessInput,
} from './data-access.types.js'

interface ManagedPolicyRow {
  project_id: string
  table_name: string
  schema_name: string
  policy_version: number
  policy: TableDataAccessInput
  column_grants: DataAccessColumnGrants
  capabilities_snapshot: DataAccessColumnCapabilities
  permissions_snapshot: MaterializedDataPermission[]
  metadata_digest: string
  revision: string
  created_by: string
  updated_by: string
  created_at: Date
  updated_at: Date
}

interface PolicyOperationRow {
  operation_id: string
  project_id: string
  schema_name: string
  table_name: string
  kind: DataAccessPolicyOperationKind
  status: DataAccessPolicyOperationStatus
  phase: string
  baseline_revision: string | null
  source_capabilities: DataAccessColumnCapabilities
  source_permissions: MaterializedDataPermission[]
  source_digest: string
  source_resource_version: string
  target_policy: TableDataAccessInput | null
  target_column_grants: DataAccessColumnGrants | null
  target_capabilities: DataAccessColumnCapabilities | null
  target_permissions: MaterializedDataPermission[] | null
  target_digest: string | null
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

export interface ManagedPolicyRecord {
  projectId: string
  tableName: string
  schemaName: string
  policyVersion: number
  policy: TableDataAccessInput
  columnGrants: DataAccessColumnGrants
  capabilitiesSnapshot: DataAccessColumnCapabilities
  permissionsSnapshot: MaterializedDataPermission[]
  metadataDigest: string
  revision: bigint
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
}

export interface PolicyOperationRecord {
  operationId: string
  projectId: string
  schemaName: string
  tableName: string
  kind: DataAccessPolicyOperationKind
  status: DataAccessPolicyOperationStatus
  phase: string
  baselineRevision: bigint | null
  sourceCapabilities: DataAccessColumnCapabilities
  sourcePermissions: MaterializedDataPermission[]
  sourceDigest: string
  sourceResourceVersion: bigint
  targetPolicy: TableDataAccessInput | null
  targetColumnGrants: DataAccessColumnGrants | null
  targetCapabilities: DataAccessColumnCapabilities | null
  targetPermissions: MaterializedDataPermission[] | null
  targetDigest: string | null
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

interface Queryable {
  query: PoolClient['query']
}

export async function getManagedPolicy(
  projectId: string,
  schemaName: string,
  tableName: string
): Promise<ManagedPolicyRecord | null> {
  const row = await queryOne<ManagedPolicyRow>(
    `SELECT * FROM druvia_data_access_managed_policies
     WHERE project_id = $1 AND schema_name = $2 AND table_name = $3`,
    [projectId, schemaName, tableName]
  )
  return row ? toManagedPolicy(row) : null
}

export async function getManagedPolicyWithClient(
  client: Queryable,
  projectId: string,
  schemaName: string,
  tableName: string
): Promise<ManagedPolicyRecord | null> {
  const result = await client.query<ManagedPolicyRow>(
    `SELECT * FROM druvia_data_access_managed_policies
     WHERE project_id = $1 AND schema_name = $2 AND table_name = $3`,
    [projectId, schemaName, tableName]
  )
  return result.rows[0] ? toManagedPolicy(result.rows[0]) : null
}

export async function listManagedPolicies(
  projectId: string,
  schemaName: string
): Promise<ManagedPolicyRecord[]> {
  const rows = await query<ManagedPolicyRow>(
    `SELECT * FROM druvia_data_access_managed_policies
     WHERE project_id = $1 AND schema_name = $2`,
    [projectId, schemaName]
  )
  return rows.map(toManagedPolicy)
}

export interface SaveManagedPolicyInput {
  projectId: string
  tableName: string
  schemaName: string
  policy: TableDataAccessInput
  columnGrants: DataAccessColumnGrants
  capabilitiesSnapshot: DataAccessColumnCapabilities
  permissionsSnapshot: MaterializedDataPermission[]
  metadataDigest: string
  actorId: string
  expectedRevision: bigint | null
}

export class ManagedPolicyRevisionConflictError extends Error {}

export async function saveManagedPolicy(
  client: Queryable,
  input: SaveManagedPolicyInput
): Promise<ManagedPolicyRecord> {
  const values = [
    input.projectId,
    input.tableName,
    input.schemaName,
    JSON.stringify(input.policy),
    JSON.stringify(input.columnGrants),
    JSON.stringify(input.capabilitiesSnapshot),
    JSON.stringify(input.permissionsSnapshot),
    input.metadataDigest,
    input.actorId,
  ]
  const result = input.expectedRevision === null
    ? await client.query<ManagedPolicyRow>(
        `INSERT INTO druvia_data_access_managed_policies (
           project_id, table_name, schema_name, policy, column_grants,
           capabilities_snapshot, permissions_snapshot, metadata_digest, created_by, updated_by
         ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $9)
         ON CONFLICT (project_id, schema_name, table_name) DO NOTHING
         RETURNING *`,
        values
      )
    : await client.query<ManagedPolicyRow>(
        `UPDATE druvia_data_access_managed_policies
         SET policy = $4::jsonb, column_grants = $5::jsonb,
             capabilities_snapshot = $6::jsonb, permissions_snapshot = $7::jsonb,
             metadata_digest = $8, updated_by = $9, revision = revision + 1,
             updated_at = NOW()
         WHERE project_id = $1 AND table_name = $2 AND schema_name = $3 AND revision = $10
         RETURNING *`,
        [...values, input.expectedRevision.toString()]
      )
  const row = result.rows[0]
  if (!row) throw new ManagedPolicyRevisionConflictError('Managed policy revision changed')
  return toManagedPolicy(row)
}

export interface CreatePolicyOperationInput {
  operationId: string
  projectId: string
  schemaName: string
  tableName: string
  kind: DataAccessPolicyOperationKind
  baselineRevision: bigint | null
  sourceCapabilities: DataAccessColumnCapabilities
  sourcePermissions: MaterializedDataPermission[]
  sourceDigest: string
  sourceResourceVersion: bigint
  targetPolicy: TableDataAccessInput | null
  targetColumnGrants: DataAccessColumnGrants | null
  targetCapabilities: DataAccessColumnCapabilities | null
  targetPermissions: MaterializedDataPermission[] | null
  targetDigest: string | null
  requestDigest: string
  createdBy: string
}

export async function createPolicyOperation(
  client: Queryable,
  input: CreatePolicyOperationInput
): Promise<PolicyOperationRecord> {
  const result = await client.query<PolicyOperationRow>(
    `INSERT INTO druvia_data_access_policy_operations (
       operation_id, project_id, schema_name, table_name, kind, status, phase, baseline_revision,
       source_capabilities, source_permissions, source_digest, source_resource_version,
       target_policy, target_column_grants, target_capabilities, target_permissions,
       target_digest, request_digest, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'preview_ready', 'preview', $6,
       $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
       $14::jsonb, $15, $16, $17
     ) RETURNING *`,
    [
      input.operationId, input.projectId, input.schemaName, input.tableName, input.kind,
      input.baselineRevision?.toString() ?? null,
      JSON.stringify(input.sourceCapabilities), JSON.stringify(input.sourcePermissions),
      input.sourceDigest, input.sourceResourceVersion.toString(),
      input.targetPolicy ? JSON.stringify(input.targetPolicy) : null,
      input.targetColumnGrants ? JSON.stringify(input.targetColumnGrants) : null,
      input.targetCapabilities ? JSON.stringify(input.targetCapabilities) : null,
      input.targetPermissions ? JSON.stringify(input.targetPermissions) : null,
      input.targetDigest, input.requestDigest, input.createdBy,
    ]
  )
  if (!result.rows[0]) throw new Error('Failed to create data access policy operation')
  return toPolicyOperation(result.rows[0])
}

export async function getPolicyOperation(
  projectId: string,
  operationId: string
): Promise<PolicyOperationRecord | null> {
  const row = await queryOne<PolicyOperationRow>(
    `SELECT * FROM druvia_data_access_policy_operations
     WHERE project_id = $1 AND operation_id = $2`,
    [projectId, operationId]
  )
  return row ? toPolicyOperation(row) : null
}

export async function getPolicyOperationWithClient(
  client: Queryable,
  projectId: string,
  operationId: string
): Promise<PolicyOperationRecord | null> {
  const result = await client.query<PolicyOperationRow>(
    `SELECT * FROM druvia_data_access_policy_operations
     WHERE project_id = $1 AND operation_id = $2`,
    [projectId, operationId]
  )
  return result.rows[0] ? toPolicyOperation(result.rows[0]) : null
}

export async function getProjectPolicyOperation(
  projectId: string
): Promise<PolicyOperationRecord | null> {
  const row = await queryOne<PolicyOperationRow>(
    `SELECT * FROM druvia_data_access_policy_operations
     WHERE project_id = $1
       AND status IN ('preview_ready', 'applying', 'recovering', 'recovery_required')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId]
  )
  return row ? toPolicyOperation(row) : null
}

export async function supersedePolicyPreviews(
  client: Queryable,
  projectId: string
): Promise<void> {
  await client.query(
    `UPDATE druvia_data_access_policy_operations
     SET status = 'superseded', phase = 'completed', completed_at = NOW()
     WHERE project_id = $1 AND status = 'preview_ready'`,
    [projectId]
  )
}

export interface PolicyOperationTransitionPatch {
  status?: DataAccessPolicyOperationStatus
  phase?: string
  targetResourceVersion?: bigint | null
  writerEpoch?: string | null
  writeDeadlineAt?: Date | null
  error?: { code: string; message: string } | null
  startedAt?: Date | null
  completedAt?: Date | null
}

export class PolicyOperationTransitionError extends Error {}

export class PolicyOperationWriterLeaseError extends Error {}

export async function transitionPolicyOperation(
  client: Queryable,
  operationId: string,
  expectedStatuses: DataAccessPolicyOperationStatus[],
  patch: PolicyOperationTransitionPatch
): Promise<PolicyOperationRecord> {
  if (expectedStatuses.length === 0) throw new Error('Expected operation status is required')
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
  if (updates.length === 0) throw new Error('Operation transition patch is empty')
  const result = await client.query<PolicyOperationRow>(
    `UPDATE druvia_data_access_policy_operations SET ${updates.join(', ')}
     WHERE operation_id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    values
  )
  if (!result.rows[0]) {
    throw new PolicyOperationTransitionError('Policy operation changed before transition')
  }
  return toPolicyOperation(result.rows[0])
}

export async function renewPolicyOperationWriterLease(
  client: Queryable,
  operationId: string,
  status: 'applying' | 'recovering',
  writerEpoch: string,
  deadline: Date
): Promise<void> {
  const result = await client.query<PolicyOperationRow>(
    `UPDATE druvia_data_access_policy_operations
     SET write_deadline_at = $4
     WHERE operation_id = $1
       AND status = $2
       AND writer_epoch = $3
       AND write_deadline_at IS NOT NULL
       AND write_deadline_at > NOW()
     RETURNING *`,
    [operationId, status, writerEpoch, deadline]
  )
  if (!result.rows[0]) {
    throw new PolicyOperationWriterLeaseError('Policy operation writer lease expired')
  }
}

export async function deleteManagedPolicy(
  client: Queryable,
  projectId: string,
  schemaName: string,
  tableName: string
): Promise<void> {
  await client.query(
    `DELETE FROM druvia_data_access_managed_policies
     WHERE project_id = $1 AND schema_name = $2 AND table_name = $3`,
    [projectId, schemaName, tableName]
  )
}

function toManagedPolicy(row: ManagedPolicyRow): ManagedPolicyRecord {
  return {
    projectId: row.project_id, tableName: row.table_name, schemaName: row.schema_name,
    policyVersion: row.policy_version, policy: row.policy, columnGrants: row.column_grants,
    capabilitiesSnapshot: row.capabilities_snapshot,
    permissionsSnapshot: row.permissions_snapshot, metadataDigest: row.metadata_digest,
    revision: BigInt(row.revision), createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toPolicyOperation(row: PolicyOperationRow): PolicyOperationRecord {
  return {
    operationId: row.operation_id, projectId: row.project_id,
    schemaName: row.schema_name, tableName: row.table_name,
    kind: row.kind, status: row.status, phase: row.phase,
    baselineRevision: row.baseline_revision === null ? null : BigInt(row.baseline_revision),
    sourceCapabilities: row.source_capabilities, sourcePermissions: row.source_permissions,
    sourceDigest: row.source_digest, sourceResourceVersion: BigInt(row.source_resource_version),
    targetPolicy: row.target_policy, targetColumnGrants: row.target_column_grants,
    targetCapabilities: row.target_capabilities, targetPermissions: row.target_permissions,
    targetDigest: row.target_digest,
    targetResourceVersion: row.target_resource_version === null ? null : BigInt(row.target_resource_version),
    requestDigest: row.request_digest, writerEpoch: row.writer_epoch,
    writeDeadlineAt: row.write_deadline_at, createdBy: row.created_by,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'Operation failed' } : null,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}
