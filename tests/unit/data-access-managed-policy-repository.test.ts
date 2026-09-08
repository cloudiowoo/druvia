import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({ queryOne: vi.fn(), query: vi.fn() }))

import { queryOne } from '../../apps/api/src/db/index.js'
import {
  createPolicyOperation,
  deleteManagedPolicy,
  getManagedPolicy,
  getPolicyOperation,
  PolicyOperationWriterLeaseError,
  renewPolicyOperationWriterLease,
  saveManagedPolicy,
  transitionPolicyOperation,
} from '../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js'

const now = new Date('2026-09-07T00:00:00Z')
const policy = {
  authenticated: {
    select: 'owner' as const, insert: 'owner' as const, update: 'none' as const,
    delete: 'none' as const, ownerColumn: 'owner_id',
  },
  anonymous: { select: false },
}
const capabilities = {
  readableColumns: ['id', 'owner_id'],
  insertableColumns: ['id', 'owner_id'],
  updateableColumns: ['id', 'owner_id'],
}
const grants = {
  authenticated: { select: ['id', 'owner_id'], insert: ['id'], update: [] },
  anonymous: { select: [] },
}
const baselineRow = {
  project_id: 'proj_1', table_name: 'orders', schema_name: 'dru_proj_1', policy_version: 1,
  policy, column_grants: grants, capabilities_snapshot: capabilities,
  permissions_snapshot: [], metadata_digest: 'a'.repeat(64), revision: '2',
  created_by: 'usr_1', updated_by: 'usr_1', created_at: now, updated_at: now,
}
const operationRow = {
  id: '1', operation_id: 'op_1', project_id: 'proj_1', table_name: 'orders',
  schema_name: 'dru_proj_1',
  kind: 'adoption', status: 'preview_ready', phase: 'preview', baseline_revision: null,
  source_capabilities: capabilities, source_permissions: [], source_digest: 'b'.repeat(64),
  source_resource_version: '5', target_policy: policy, target_column_grants: grants,
  target_capabilities: capabilities, target_permissions: [], target_digest: 'c'.repeat(64),
  target_resource_version: null, request_digest: 'd'.repeat(64), writer_epoch: null,
  write_deadline_at: null, created_by: 'usr_1', error_code: null, error_message: null,
  created_at: now, started_at: null, completed_at: null, updated_at: now,
}

describe('managed data access policy repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(queryOne).mockResolvedValue(null)
  })

  it('loads and maps baseline revisions without losing bigint precision', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(baselineRow as never)
    await expect(getManagedPolicy('proj_1', 'dru_proj_1', 'orders')).resolves.toMatchObject({
      projectId: 'proj_1', revision: 2n, columnGrants: grants,
    })
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringMatching(/project_id = \$1 AND schema_name = \$2 AND table_name = \$3/),
      ['proj_1', 'dru_proj_1', 'orders']
    )
  })

  it('uses expected revision CAS for an existing baseline', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [baselineRow], rowCount: 1 }) }
    await saveManagedPolicy(client as never, {
      projectId: 'proj_1', tableName: 'orders', schemaName: 'dru_proj_1', policy,
      columnGrants: grants, capabilitiesSnapshot: capabilities, permissionsSnapshot: [],
      metadataDigest: 'a'.repeat(64), actorId: 'usr_1', expectedRevision: 1n,
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'WHERE project_id = $1 AND table_name = $2 AND schema_name = $3 AND revision = $10'
      ),
      expect.arrayContaining(['proj_1', 'orders', 'dru_proj_1', '1']),
    )
  })

  it('creates an independent baseline for the same table name in a new schema', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [baselineRow], rowCount: 1 }) }
    await saveManagedPolicy(client as never, {
      projectId: 'proj_1', tableName: 'orders', schemaName: 'dru_preview_proj_1', policy,
      columnGrants: grants, capabilitiesSnapshot: capabilities, permissionsSnapshot: [],
      metadataDigest: 'a'.repeat(64), actorId: 'usr_1', expectedRevision: null,
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (project_id, schema_name, table_name) DO NOTHING'),
      expect.arrayContaining(['proj_1', 'orders', 'dru_preview_proj_1']),
    )
  })

  it('persists immutable operation payload and guarded transitions', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [operationRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...operationRow, status: 'applying' }], rowCount: 1 }) }
    await createPolicyOperation(client as never, {
      operationId: 'op_1', projectId: 'proj_1', schemaName: 'dru_proj_1', tableName: 'orders', kind: 'adoption',
      baselineRevision: null, sourceCapabilities: capabilities, sourcePermissions: [],
      sourceDigest: 'b'.repeat(64), sourceResourceVersion: 5n, targetPolicy: policy,
      targetColumnGrants: grants, targetCapabilities: capabilities, targetPermissions: [],
      targetDigest: 'c'.repeat(64), requestDigest: 'd'.repeat(64), createdBy: 'usr_1',
    })
    await transitionPolicyOperation(client as never, 'op_1', ['preview_ready'], {
      status: 'applying', phase: 'source_check', startedAt: now,
    })
    expect(client.query.mock.calls[1][0]).toContain('status = ANY($2::text[])')
    expect(client.query.mock.calls[0][0]).toContain('schema_name')
  })

  it('queries operation IDs in project scope for idempotent retries', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(operationRow as never)
    await getPolicyOperation('proj_1', 'op_1')
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('project_id = $1 AND operation_id = $2'), [
      'proj_1', 'op_1',
    ])
  })

  it('renews only a live writer lease owned by the expected epoch', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [operationRow], rowCount: 1 }) }

    await renewPolicyOperationWriterLease(
      client as never,
      'op_1',
      'applying',
      'writer_1',
      new Date('2026-09-07T00:00:30Z')
    )

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/status = \$2[\s\S]*writer_epoch = \$3[\s\S]*write_deadline_at > NOW\(\)/),
      ['op_1', 'applying', 'writer_1', new Date('2026-09-07T00:00:30Z')]
    )
  })

  it('rejects renewal after the writer lease or epoch is no longer current', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }

    await expect(renewPolicyOperationWriterLease(
      client as never,
      'op_1',
      'recovering',
      'stale_writer',
      new Date('2026-09-07T00:00:30Z')
    )).rejects.toBeInstanceOf(PolicyOperationWriterLeaseError)
  })

  it('deletes a baseline only for the exact project schema and table', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }

    await deleteManagedPolicy(client as never, 'proj_1', 'dru_preview_proj_1', 'orders')

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/project_id = \$1 AND schema_name = \$2 AND table_name = \$3/),
      ['proj_1', 'dru_preview_proj_1', 'orders']
    )
  })
})
