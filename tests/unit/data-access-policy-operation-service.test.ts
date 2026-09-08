import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getTableMetadata: vi.fn(),
  metadataRequest: vi.fn(),
  applyCommands: vi.fn(),
  replacePermissions: vi.fn(),
  getManagedPolicy: vi.fn(),
  getManagedPolicyWithClient: vi.fn(),
  getPolicyOperation: vi.fn(),
  getPolicyOperationWithClient: vi.fn(),
  getProjectPolicyOperation: vi.fn(),
  createPolicyOperation: vi.fn(),
  supersedePolicyPreviews: vi.fn(),
  transitionPolicyOperation: vi.fn(),
  renewWriterLease: vi.fn(),
  saveManagedPolicy: vi.fn(),
  withMutationLock: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: mocks.getProjectById,
}))
vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  getTableMetadata: mocks.getTableMetadata,
  trackTableInHasura: vi.fn(async () => true),
}))
vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  HasuraMetadataRequestError: class HasuraMetadataRequestError extends Error {
    readonly code: string | null
    constructor(readonly status: number, readonly responseBody: string) {
      super(`Hasura metadata request failed with HTTP ${status}: ${responseBody}`)
      this.code = JSON.parse(responseBody).code ?? null
    }
    get isDefinitiveRejection() {
      return this.status >= 400 && this.status < 500 && this.code !== null
    }
  },
  hasuraMetadataRequestWithOptions: mocks.metadataRequest,
}))
vi.mock('../../apps/api/src/modules/data-access/hasura-metadata-bulk.js', () => ({
  applyHasuraMetadataCommands: mocks.applyCommands,
  replaceHasuraTablePermissions: mocks.replacePermissions,
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: mocks.withMutationLock,
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js', () => ({
  PolicyOperationWriterLeaseError: class PolicyOperationWriterLeaseError extends Error {},
  getManagedPolicy: mocks.getManagedPolicy,
  getManagedPolicyWithClient: mocks.getManagedPolicyWithClient,
  getPolicyOperation: mocks.getPolicyOperation,
  getPolicyOperationWithClient: mocks.getPolicyOperationWithClient,
  getProjectPolicyOperation: mocks.getProjectPolicyOperation,
  createPolicyOperation: mocks.createPolicyOperation,
  supersedePolicyPreviews: mocks.supersedePolicyPreviews,
  transitionPolicyOperation: mocks.transitionPolicyOperation,
  renewPolicyOperationWriterLease: mocks.renewWriterLease,
  saveManagedPolicy: mocks.saveManagedPolicy,
}))

import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  applyPolicyAdoption,
  applyPolicyReconcile,
  previewPolicyAdoption,
  previewPolicyReconcile,
  recoverPolicyOperation,
  updateManagedTablePolicy,
} from '../../apps/api/src/modules/data-access/data-access-policy-operation.service.js'
import { PolicyOperationWriterLeaseError } from '../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js'
import { HasuraMetadataRequestError } from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  permissionSnapshotDigest,
  stableDigest,
} from '../../apps/api/src/modules/data-access/data-access-managed-policy.js'

const projectId = 'proj_123'
const tableName = 'football_session'
const schemaName = 'dru_default_pitchetch'
const roles = {
  authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
  anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
}
const oldColumns = ['id', 'user_id', 'title']
const ownerFilter = { user_id: { _eq: 'X-Hasura-User-Id' } }

function metadata(columns = oldColumns) {
  return {
    resource_version: 801,
    metadata: {
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: schemaName, name: tableName },
          select_permissions: [{
            role: roles.authenticated,
            permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
          }],
          insert_permissions: [{
            role: roles.authenticated,
            permission: {
              columns: ['id', 'title'], check: ownerFilter,
              set: { user_id: 'X-Hasura-User-Id' },
            },
          }],
        }],
      }],
    },
    columns,
  }
}

function metadataPermissions() {
  return [
    {
      role: roles.authenticated, operation: 'select' as const,
      permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
    },
    {
      role: roles.authenticated, operation: 'insert' as const,
      permission: {
        columns: ['id', 'title'], check: ownerFilter,
        set: { user_id: 'X-Hasura-User-Id' },
      },
    },
  ]
}

function operationFrom(input: Record<string, unknown>) {
  const now = new Date('2026-09-07T00:00:00Z')
  return {
    schemaName, ...input,
    status: 'preview_ready', phase: 'preview', targetResourceVersion: null,
    writerEpoch: null, writeDeadlineAt: null, error: null,
    createdAt: now, startedAt: null, completedAt: null, updatedAt: now,
  }
}

describe('data access policy operation service', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.getProjectById.mockResolvedValue({
      projectId, schemaName, alias: 'pitchetch', dataAccessMode: 'explicit',
    })
    mocks.getTableMetadata.mockResolvedValue({
      schemaName, tableName,
      columns: oldColumns.map((name) => ({
        name, type: 'text', nullable: false, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    mocks.metadataRequest.mockResolvedValue(metadata())
    mocks.getManagedPolicy.mockResolvedValue(null)
    mocks.getManagedPolicyWithClient.mockResolvedValue(null)
    mocks.getPolicyOperation.mockResolvedValue(null)
    mocks.getPolicyOperationWithClient.mockResolvedValue(null)
    mocks.getProjectPolicyOperation.mockResolvedValue(null)
    mocks.applyCommands.mockResolvedValue(undefined)
    mocks.replacePermissions.mockResolvedValue(undefined)
    mocks.renewWriterLease.mockResolvedValue(undefined)
    mocks.createPolicyOperation.mockImplementation(async (_client, input) => operationFrom(input))
    mocks.withMutationLock.mockImplementation(async (_projectId, callback) => callback({ query: vi.fn() }))
  })

  it.each([
    { outcome: 'committed', expectedCode: null },
    { outcome: 'not_committed', expectedCode: 'DATA_ACCESS_UPSTREAM_ERROR' },
    { outcome: 'uncertain', expectedCode: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED' },
  ] as const)('handles an unknown COMMIT as $outcome through the full policy update path', async ({
    outcome,
    expectedCode,
  }) => {
    const input = {
      operationId: `operation_unknown_commit_${outcome}`,
      authenticated: {
        select: 'none' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: [], insert: [], update: [] },
        anonymous: { select: [] },
      },
    }
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName }, configuration: {} }],
        }],
      },
    }
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'COMMIT') throw new Error('connection lost while committing')
      }),
    }
    mocks.withMutationLock.mockImplementation(async (_projectId, callback) => callback(client))
    mocks.metadataRequest.mockResolvedValue(emptyMetadata)
    mocks.getPolicyOperation.mockResolvedValueOnce(null).mockImplementation(async () => {
      const created = operationFrom(mocks.createPolicyOperation.mock.calls[0][1])
      return { ...created, status: outcome === 'not_committed' ? 'applying' : 'completed' }
    })
    mocks.getPolicyOperationWithClient.mockImplementation(async () => {
      if (mocks.createPolicyOperation.mock.calls.length === 0) return null
      const created = operationFrom(mocks.createPolicyOperation.mock.calls[0][1])
      const writerEpoch = mocks.transitionPolicyOperation.mock.calls.find(
        (call) => call[3]?.status === 'applying'
      )?.[3]?.writerEpoch
      return { ...created, status: 'applying', writerEpoch }
    })
    mocks.getManagedPolicy.mockImplementation(async () => {
      if (outcome === 'not_committed') return null
      const permissions = outcome === 'committed' ? [] : metadataPermissions()
      return {
        projectId, schemaName, tableName, revision: 1n,
        permissionsSnapshot: permissions,
        metadataDigest: permissionSnapshotDigest(permissions),
      }
    })
    const update = updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({ projectId, tableName }) as never
    )

    if (expectedCode === null) await expect(update).resolves.toEqual({ projectId, tableName })
    else await expect(update).rejects.toMatchObject({ code: expectedCode })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    const recovering = mocks.transitionPolicyOperation.mock.calls.some(
      (call) => call[3]?.status === 'recovering'
    )
    expect(recovering).toBe(outcome === 'not_committed')
  })

  it('keeps a recovered source when an old resource-version writer finishes late', async () => {
    const input = {
      operationId: 'operation_late_writer',
      authenticated: {
        select: 'all' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: oldColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
    }
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName }, configuration: {} }],
        }],
      },
    }
    let releaseOldWriter: () => void = () => undefined
    const oldWriterGate = new Promise<void>((resolve) => {
      releaseOldWriter = resolve
    })
    const oldClient = { connected: true, query: vi.fn() }
    const recoveryClient = { connected: true, query: vi.fn() }
    let lockCall = 0
    mocks.withMutationLock.mockImplementation(async (_projectId, callback) => {
      lockCall += 1
      return callback(lockCall === 1 ? oldClient : recoveryClient)
    })
    let metadataResourceVersion = 801n
    let persistedStatus = 'preview_ready'
    mocks.metadataRequest.mockImplementation(async (type, _args, options) => {
      if (type === 'export_metadata') {
        return { ...emptyMetadata, resource_version: Number(metadataResourceVersion) }
      }
      if (type === 'pg_set_table_customization') {
        if (options.resourceVersion !== metadataResourceVersion) {
          throw new HasuraMetadataRequestError(409, JSON.stringify({
            code: 'conflict', error: 'metadata resource version mismatch',
          }))
        }
        metadataResourceVersion += 1n
        return { message: 'success' }
      }
      throw new Error(`Unexpected metadata request: ${type}`)
    })
    mocks.applyCommands.mockImplementationOnce(async (_commands, options) => {
      await oldWriterGate
      if (options.resourceVersion !== metadataResourceVersion) {
        throw new HasuraMetadataRequestError(409, JSON.stringify({
          code: 'conflict', error: 'metadata resource version mismatch',
        }))
      }
      metadataResourceVersion += 1n
    })
    mocks.transitionPolicyOperation.mockImplementation(async (
      client, _operationId, expectedStatuses, patch
    ) => {
      if (!client.connected) throw new Error('database connection terminated')
      if (!expectedStatuses.includes(persistedStatus)) {
        throw new Error(`transition conflict from ${persistedStatus}`)
      }
      persistedStatus = patch.status
      return { status: persistedStatus, phase: patch.phase } as never
    })

    const applyPromise = updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({ projectId, tableName }) as never
    )
    await vi.waitFor(() => expect(mocks.applyCommands).toHaveBeenCalledOnce())
    const operation = {
      ...operationFrom(mocks.createPolicyOperation.mock.calls[0][1]),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    oldClient.connected = false
    persistedStatus = 'recovery_required'
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).resolves.toMatchObject({ status: 'failed' })

    releaseOldWriter()
    await expect(applyPromise).rejects.toThrow('database connection terminated')
    expect(persistedStatus).toBe('failed')
    expect(metadataResourceVersion).toBe(802n)
    expect(mocks.applyCommands).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ resourceVersion: 801n })
    )
    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'pg_set_table_customization', expect.anything(),
      { resourceVersion: 801n, timeoutMs: 30_000 }
    )
  })

  it('adopts supported explicit permissions without a Hasura mutation', async () => {
    const preview = await previewPolicyAdoption(projectId, tableName, 'usr_1')

    expect(preview.policy.authenticated).toMatchObject({
      select: 'owner', insert: 'owner', ownerColumn: 'user_id',
    })
    expect(preview.columnGrants.authenticated.insert).toEqual(['id', 'title'])
    expect(mocks.createPolicyOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'adoption', sourceResourceVersion: 801n })
    )
    expect(mocks.applyCommands).not.toHaveBeenCalled()
  })

  it('validates a completed adoption replay against its confirmation and current baseline', async () => {
    const preview = await previewPolicyAdoption(projectId, tableName, 'usr_1')
    const operation = {
      ...operationFrom(mocks.createPolicyOperation.mock.calls[0][1]),
      status: 'completed',
    }
    const baseline = {
      projectId, tableName, schemaName, policyVersion: 1,
      policy: operation.targetPolicy,
      columnGrants: operation.targetColumnGrants,
      capabilitiesSnapshot: operation.targetCapabilities,
      permissionsSnapshot: operation.targetPermissions,
      metadataDigest: permissionSnapshotDigest(operation.targetPermissions),
      revision: 1n, createdBy: 'usr_1', updatedBy: 'usr_1',
      createdAt: new Date(), updatedAt: new Date(),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValue(operation)
    mocks.getManagedPolicyWithClient.mockResolvedValue(baseline)
    const getState = vi.fn(async () => ({ projectId, tableName }) as never)

    await expect(applyPolicyAdoption(projectId, tableName, {
      operationId: operation.operationId,
      sourceDigest: preview.operation.sourceDigest,
      projectAlias: 'pitchetch',
    }, 'usr_1', getState)).resolves.toEqual({ projectId, tableName })

    await expect(applyPolicyAdoption(projectId, tableName, {
      operationId: operation.operationId,
      sourceDigest: 'f'.repeat(64),
      projectAlias: 'pitchetch',
    }, 'usr_1', getState)).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_STALE' })

    mocks.getManagedPolicyWithClient.mockResolvedValue({ ...baseline, revision: 2n })
    await expect(applyPolicyAdoption(projectId, tableName, {
      operationId: operation.operationId,
      sourceDigest: preview.operation.sourceDigest,
      projectAlias: 'pitchetch',
    }, 'usr_1', getState)).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_STALE' })
    expect(getState).toHaveBeenCalledOnce()
  })

  it('validates a completed reconcile replay against its immutable payload and current baseline', async () => {
    const policy = {
      authenticated: {
        select: 'none' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
    }
    const columnGrants = {
      authenticated: { select: [], insert: [], update: [] },
      anonymous: { select: [] },
    }
    const capabilities = {
      readableColumns: oldColumns,
      insertableColumns: oldColumns,
      updateableColumns: oldColumns,
    }
    const operation = {
      ...operationFrom({
        operationId: 'operation_completed_reconcile', projectId, tableName, kind: 'reconcile',
        baselineRevision: 1n, sourceCapabilities: capabilities, sourcePermissions: [],
        sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: policy, targetColumnGrants: columnGrants,
        targetCapabilities: capabilities, targetPermissions: [], targetDigest: 'b'.repeat(64),
        requestDigest: 'c'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'completed', targetResourceVersion: 802n,
    }
    const baseline = {
      projectId, tableName, schemaName, policyVersion: 1, policy, columnGrants,
      capabilitiesSnapshot: capabilities, permissionsSnapshot: [],
      metadataDigest: permissionSnapshotDigest([]), revision: 2n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValue(operation)
    mocks.getManagedPolicyWithClient.mockResolvedValue(baseline)
    const getState = vi.fn(async () => ({ projectId, tableName }) as never)
    const input = {
      operationId: operation.operationId,
      sourceDigest: operation.sourceDigest,
      targetDigest: operation.targetDigest!,
      baselineRevision: 1,
      projectAlias: 'pitchetch',
      columnGrants,
      policy,
    }

    await expect(applyPolicyReconcile(
      projectId, tableName, input, 'usr_1', getState
    )).resolves.toEqual({ projectId, tableName })

    await expect(applyPolicyReconcile(projectId, tableName, {
      ...input,
      policy: { ...policy, anonymous: { select: true } },
    }, 'usr_1', getState)).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_STALE' })

    mocks.getManagedPolicyWithClient.mockResolvedValue({ ...baseline, revision: 3n })
    await expect(applyPolicyReconcile(
      projectId, tableName, input, 'usr_1', getState
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_STALE' })
    expect(getState).toHaveBeenCalledOnce()
  })

  it('does not send an apply mutation after the writer lease expires', async () => {
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName } }],
        }],
      },
    }
    mocks.metadataRequest.mockResolvedValue(emptyMetadata)
    mocks.renewWriterLease.mockRejectedValueOnce(new PolicyOperationWriterLeaseError())
    const input = {
      operationId: 'operation_expired_apply',
      authenticated: {
        select: 'none' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: [], insert: [], update: [] },
        anonymous: { select: [] },
      },
    }

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({}) as never
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })

    expect(mocks.applyCommands).not.toHaveBeenCalled()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
  })

  it('rechecks the apply writer lease before a metadata fallback', async () => {
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{ name: 'default', tables: [{ table: { schema: schemaName, name: tableName } }] }],
      },
    }
    mocks.metadataRequest.mockResolvedValue(emptyMetadata)
    mocks.renewWriterLease
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PolicyOperationWriterLeaseError())
    mocks.applyCommands.mockImplementationOnce(async (_commands, options) => {
      await options.beforeFallback()
    })
    const input = {
      operationId: 'operation_expired_apply_fallback',
      authenticated: {
        select: 'all' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: oldColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
    }

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({}) as never
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })
    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.renewWriterLease).toHaveBeenCalledTimes(2)
  })

  it('does not send a direct recovery mutation after the recovery lease expires', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_expired_recovery', projectId, tableName, kind: 'policy_update',
        baselineRevision: null, sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: metadataPermissions(),
        targetDigest: permissionSnapshotDigest(metadataPermissions()),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValue(operation)
    mocks.renewWriterLease.mockRejectedValueOnce(new PolicyOperationWriterLeaseError())

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })

    expect(mocks.applyCommands).not.toHaveBeenCalled()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
  })

  it('rechecks the direct recovery writer lease before a metadata fallback', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_expired_recovery_fallback', projectId, tableName,
        kind: 'policy_update', baselineRevision: null,
        sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: metadataPermissions(),
        targetDigest: permissionSnapshotDigest(metadataPermissions()),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required', writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValue(operation)
    mocks.renewWriterLease
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PolicyOperationWriterLeaseError())
    mocks.applyCommands.mockImplementationOnce(async (_commands, options) => {
      await options.beforeFallback()
    })

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })
    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.renewWriterLease).toHaveBeenCalledTimes(2)
  })

  it('does not send an automatic restore mutation after the recovery lease expires', async () => {
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName } }],
        }],
      },
    }
    mocks.metadataRequest
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce({ ...emptyMetadata, resource_version: 802 })
      .mockResolvedValueOnce({ ...emptyMetadata, resource_version: 802 })
    mocks.renewWriterLease
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PolicyOperationWriterLeaseError())
    const input = {
      operationId: 'operation_expired_restore',
      authenticated: {
        select: 'all' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: oldColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
    }

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({}) as never
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })

    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
  })

  it('rechecks the automatic restore writer lease before a metadata fallback', async () => {
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{ name: 'default', tables: [{ table: { schema: schemaName, name: tableName } }] }],
      },
    }
    mocks.metadataRequest
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce({ ...emptyMetadata, resource_version: 802 })
      .mockResolvedValueOnce({ ...emptyMetadata, resource_version: 802 })
    mocks.renewWriterLease
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PolicyOperationWriterLeaseError())
    mocks.applyCommands
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (_commands, options) => {
        await options.beforeFallback()
      })
    const input = {
      operationId: 'operation_expired_restore_fallback',
      authenticated: {
        select: 'all' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: oldColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
    }

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({}) as never
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })
    expect(mocks.applyCommands).toHaveBeenCalledTimes(2)
    expect(mocks.renewWriterLease).toHaveBeenCalledTimes(3)
  })

  it('replays a completed PUT only while its target baseline is still current', async () => {
    const input = {
      operationId: 'operation_completed_retry',
      authenticated: {
        select: 'none' as const,
        insert: 'none' as const,
        update: 'none' as const,
        delete: 'none' as const,
        ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: [], insert: [], update: [] },
        anonymous: { select: [] },
      },
    }
    const completed = {
      ...operationFrom({
        operationId: input.operationId,
        projectId,
        tableName,
        kind: 'policy_update',
        baselineRevision: null,
        sourceCapabilities: {
          readableColumns: oldColumns,
          insertableColumns: oldColumns,
          updateableColumns: oldColumns,
        },
        sourcePermissions: [],
        sourceDigest: 'a'.repeat(64),
        sourceResourceVersion: 800n,
        targetPolicy: {
          authenticated: input.authenticated,
          anonymous: input.anonymous,
        },
        targetColumnGrants: input.columnGrants,
        targetCapabilities: {
          readableColumns: oldColumns,
          insertableColumns: oldColumns,
          updateableColumns: oldColumns,
        },
        targetPermissions: [],
        targetDigest: 'b'.repeat(64),
        requestDigest: stableDigest({ projectId, tableName, input }),
        createdBy: 'usr_1',
      }),
      status: 'completed',
      targetResourceVersion: 802n,
    }
    const baseline = {
      projectId,
      tableName,
      schemaName,
      policyVersion: 1,
      policy: completed.targetPolicy,
      columnGrants: input.columnGrants,
      capabilitiesSnapshot: completed.targetCapabilities,
      permissionsSnapshot: [],
      metadataDigest: permissionSnapshotDigest([]),
      revision: 1n,
      createdBy: 'usr_1',
      updatedBy: 'usr_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    mocks.getPolicyOperation.mockResolvedValue(completed)
    mocks.getPolicyOperationWithClient.mockResolvedValue(completed)
    mocks.getManagedPolicyWithClient.mockResolvedValueOnce(baseline)
    let lockHeld = false
    mocks.withMutationLock.mockImplementation(async (_projectId, callback) => {
      lockHeld = true
      try {
        return await callback({ query: vi.fn() })
      } finally {
        lockHeld = false
      }
    })
    const getState = vi.fn(async () => {
      expect(lockHeld).toBe(true)
      return { projectId, tableName } as never
    })

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', getState
    )).resolves.toEqual({ projectId, tableName })

    mocks.getManagedPolicyWithClient.mockResolvedValueOnce({ ...baseline, revision: 2n })
    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', getState
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_STALE' })
    expect(getState).toHaveBeenCalledOnce()
  })

  it('resumes the same policy PUT after a crash before writer claim', async () => {
    const input = {
      operationId: 'operation_preview_retry',
      authenticated: {
        select: 'none' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: [], insert: [], update: [] },
        anonymous: { select: [] },
      },
    }
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName } }],
        }],
      },
    }
    mocks.metadataRequest
      .mockResolvedValueOnce(emptyMetadata)
      .mockRejectedValueOnce(new Error('process exited before writer claim'))
    const getState = vi.fn(async () => ({ projectId, tableName }) as never)

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', getState
    )).rejects.toThrow('process exited before writer claim')
    const operation = operationFrom(mocks.createPolicyOperation.mock.calls[0][1])

    mocks.getPolicyOperation.mockResolvedValueOnce(operation)
    mocks.getPolicyOperationWithClient
      .mockResolvedValueOnce(operation)
      .mockImplementation(async () => ({
        ...operation,
        status: 'applying',
        writerEpoch: mocks.transitionPolicyOperation.mock.calls.find(
          (call) => call[3]?.status === 'applying'
        )?.[3]?.writerEpoch,
      }))
    mocks.metadataRequest.mockReset()
    mocks.metadataRequest.mockResolvedValue(emptyMetadata)

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', getState
    )).resolves.toEqual({ projectId, tableName })
    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.transitionPolicyOperation).toHaveBeenCalledWith(
      expect.anything(), operation.operationId, ['preview_ready'],
      expect.objectContaining({ status: 'applying', writerEpoch: expect.any(String) })
    )
  })

  it('reconciles capability drift without granting newly added columns', async () => {
    const currentColumns = [...oldColumns, 'target_algorithm_version', 'current_analysis_run_id']
    mocks.getTableMetadata.mockResolvedValueOnce({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const permissions = [
      {
        role: roles.authenticated, operation: 'insert',
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select',
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    mocks.getManagedPolicyWithClient.mockResolvedValueOnce({
      projectId, tableName, schemaName, policyVersion: 1,
      policy: {
        authenticated: {
          select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'user_id',
        },
        anonymous: { select: false },
      },
      columnGrants: {
        authenticated: { select: oldColumns, insert: ['id', 'title'], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
      },
      permissionsSnapshot: permissions,
      metadataDigest: 'a'.repeat(64), revision: 1n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    })

    const preview = await previewPolicyReconcile(projectId, tableName, 'usr_1')

    expect(preview.drift?.addedReadable).toEqual([
      'current_analysis_run_id', 'target_algorithm_version',
    ])
    expect(preview.columnGrants.authenticated.select).toEqual([...oldColumns].sort())
    expect(preview.columnGrants.authenticated.insert).toEqual(['id', 'title'])
    expect(mocks.applyCommands).not.toHaveBeenCalled()
  })

  it('previews reconciliation when an old granted column is no longer readable', async () => {
    const currentColumns = ['id', 'user_id']
    mocks.getTableMetadata.mockResolvedValueOnce({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const permissions = [
      {
        role: roles.authenticated, operation: 'insert',
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select',
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    mocks.getManagedPolicyWithClient.mockResolvedValueOnce({
      projectId, tableName, schemaName, policyVersion: 1,
      policy: {
        authenticated: {
          select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'user_id',
        },
        anonymous: { select: false },
      },
      columnGrants: {
        authenticated: { select: oldColumns, insert: ['id', 'title'], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
      },
      permissionsSnapshot: permissions,
      metadataDigest: 'a'.repeat(64), revision: 1n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    })

    const preview = await previewPolicyReconcile(projectId, tableName, 'usr_1')

    expect(preview.drift?.removedOrRestricted).toEqual(['title'])
    expect(preview.columnGrants.authenticated.select).toEqual(['id', 'user_id'])
    expect(preview.columnGrants.authenticated.insert).toEqual(['id'])
  })

  it('allows reconciliation to explicitly close owner rules after the owner column is removed', async () => {
    const currentColumns = ['id', 'title']
    mocks.getTableMetadata.mockResolvedValueOnce({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const permissions = [
      {
        role: roles.authenticated, operation: 'insert',
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select',
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    mocks.getManagedPolicyWithClient.mockResolvedValueOnce({
      projectId, tableName, schemaName, policyVersion: 1,
      policy: {
        authenticated: {
          select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'user_id',
        },
        anonymous: { select: false },
      },
      columnGrants: {
        authenticated: { select: oldColumns, insert: ['id', 'title'], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
      },
      permissionsSnapshot: permissions,
      metadataDigest: 'a'.repeat(64), revision: 1n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    })
    const targetPolicy = {
      authenticated: {
        select: 'none' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
    }

    const preview = await previewPolicyReconcile(projectId, tableName, 'usr_1', {
      policy: targetPolicy,
    })

    expect(preview.policy).toEqual(targetPolicy)
    expect(preview.columnGrants).toEqual({
      authenticated: { select: [], insert: [], update: [] },
      anonymous: { select: [] },
    })
    expect(mocks.createPolicyOperation).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ targetPolicy })
    )
  })

  it('does not restore source after a definitive Hasura rejection', async () => {
    const currentColumns = [...oldColumns, 'analysis_version']
    mocks.getTableMetadata.mockResolvedValue({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const permissions = [
      {
        role: roles.authenticated, operation: 'insert',
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select',
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    const baseline = {
      projectId, tableName, schemaName, policyVersion: 1,
      policy: {
        authenticated: {
          select: 'owner' as const, insert: 'owner' as const, update: 'none' as const,
          delete: 'none' as const, ownerColumn: 'user_id',
        },
        anonymous: { select: false },
      },
      columnGrants: {
        authenticated: { select: oldColumns, insert: ['id', 'title'], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
      },
      permissionsSnapshot: permissions,
      metadataDigest: 'a'.repeat(64), revision: 1n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    }
    mocks.getManagedPolicyWithClient.mockResolvedValue(baseline)
    const preview = await previewPolicyReconcile(projectId, tableName, 'usr_1')
    const record = operationFrom(mocks.createPolicyOperation.mock.calls[0][1])
    mocks.getPolicyOperationWithClient.mockResolvedValue(record)
    mocks.applyCommands.mockRejectedValueOnce(
      new HasuraMetadataRequestError(409, JSON.stringify({
        code: 'conflict', error: 'metadata resource version mismatch',
      }))
    )

    await expect(applyPolicyReconcile(projectId, tableName, {
      operationId: preview.operation.operationId,
      sourceDigest: preview.operation.sourceDigest,
      targetDigest: preview.operation.targetDigest!,
      baselineRevision: preview.baselineRevision!,
      projectAlias: 'pitchetch',
      columnGrants: preview.columnGrants,
      policy: preview.policy,
    }, 'usr_1', async () => ({}) as never)).rejects.toMatchObject({
      code: 'DATA_ACCESS_UPSTREAM_ERROR',
    })

    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    const applyingTransitions = mocks.transitionPolicyOperation.mock.calls.filter(
      (call) => call[3]?.status === 'applying'
    )
    expect(applyingTransitions).toHaveLength(1)
    expect(applyingTransitions[0]?.[3]).toEqual(expect.objectContaining({
      status: 'applying',
      phase: 'apply_permissions',
      writerEpoch: expect.any(String),
      writeDeadlineAt: expect.any(Date),
    }))
    expect(mocks.metadataRequest).toHaveBeenCalledTimes(3)
    expect(mocks.transitionPolicyOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      record.operationId,
      ['applying'],
      expect.objectContaining({ status: 'failed' })
    )
  })

  it('defers recovery after a Hasura 5xx with an unknown write outcome', async () => {
    const currentColumns = [...oldColumns, 'analysis_version']
    mocks.getTableMetadata.mockResolvedValue({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const permissions = [
      {
        role: roles.authenticated, operation: 'insert',
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select',
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    const baseline = {
      projectId, tableName, schemaName, policyVersion: 1,
      policy: {
        authenticated: {
          select: 'owner' as const, insert: 'owner' as const, update: 'none' as const,
          delete: 'none' as const, ownerColumn: 'user_id',
        },
        anonymous: { select: false },
      },
      columnGrants: {
        authenticated: { select: oldColumns, insert: ['id', 'title'], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
      },
      permissionsSnapshot: permissions,
      metadataDigest: 'a'.repeat(64), revision: 1n,
      createdBy: 'usr_1', updatedBy: 'usr_1', createdAt: new Date(), updatedAt: new Date(),
    }
    mocks.getManagedPolicyWithClient.mockResolvedValue(baseline)
    const preview = await previewPolicyReconcile(projectId, tableName, 'usr_1')
    const record = operationFrom(mocks.createPolicyOperation.mock.calls[0][1])
    mocks.getPolicyOperationWithClient.mockResolvedValue(record)
    mocks.applyCommands.mockRejectedValueOnce(
      new HasuraMetadataRequestError(503, JSON.stringify({ code: 'unavailable' }))
    )

    await expect(applyPolicyReconcile(projectId, tableName, {
      operationId: preview.operation.operationId,
      sourceDigest: preview.operation.sourceDigest,
      targetDigest: preview.operation.targetDigest!,
      baselineRevision: preview.baselineRevision!,
      projectAlias: 'pitchetch',
      columnGrants: preview.columnGrants,
      policy: preview.policy,
    }, 'usr_1', async () => ({}) as never)).rejects.toMatchObject({
      code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
    })

    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.metadataRequest).toHaveBeenCalledTimes(3)
    expect(mocks.transitionPolicyOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      record.operationId,
      ['applying'],
      expect.objectContaining({ status: 'recovery_required', phase: 'verify_source' })
    )
  })

  it('fences an empty-source recovery with same-value table customization', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_recovery', projectId, tableName, kind: 'policy_update',
        baselineRevision: null, sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: metadataPermissions(),
        targetDigest: permissionSnapshotDigest(metadataPermissions()),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    const emptyMetadata = {
      ...metadata(),
      metadata: {
        sources: [{
          name: 'default',
          tables: [{ table: { schema: schemaName, name: tableName }, configuration: {} }],
        }],
      },
    }
    mocks.metadataRequest
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce({ message: 'success' })
      .mockResolvedValueOnce({ ...emptyMetadata, resource_version: 802 })
    mocks.transitionPolicyOperation
      .mockResolvedValueOnce({ ...operation, status: 'recovering', phase: 'restore_source' })
      .mockResolvedValueOnce({ ...operation, status: 'failed', phase: 'completed' })

    const result = await recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })

    expect(mocks.metadataRequest).toHaveBeenNthCalledWith(
      2,
      'pg_set_table_customization',
      {
        source: 'default', table: { schema: schemaName, name: tableName }, configuration: {},
      },
      { resourceVersion: 801n, timeoutMs: 30_000 }
    )
    expect(result.status).toBe('failed')
  })

  it('rejects direct recovery of a no-deadline writer before the orphan window', async () => {
    const now = new Date()
    const operation = {
      ...operationFrom({
        operationId: 'operation_fresh_orphan', projectId, tableName, kind: 'policy_update',
        baselineRevision: null, sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: null, targetDigest: null, requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'applying',
      startedAt: now,
      updatedAt: now,
      writeDeadlineAt: null,
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS' })
    expect(mocks.applyCommands).not.toHaveBeenCalled()
    expect(mocks.transitionPolicyOperation).not.toHaveBeenCalled()
  })

  it('does not overwrite a third-party scoped permission during manual recovery', async () => {
    const sourcePermissions = metadataPermissions()
    const operation = {
      ...operationFrom({
        operationId: 'operation_custom_manual_recovery', projectId, tableName,
        kind: 'policy_update', baselineRevision: null,
        sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions, sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: [], targetDigest: permissionSnapshotDigest([]),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    const customMetadata = metadata()
    customMetadata.metadata.sources[0].tables[0].select_permissions[0].permission.filter = {
      team_id: { _eq: 'X-Hasura-User-Id' },
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    mocks.metadataRequest.mockResolvedValueOnce(customMetadata)

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED' })

    expect(mocks.applyCommands).not.toHaveBeenCalled()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
    expect(mocks.transitionPolicyOperation).not.toHaveBeenCalled()
  })

  it('keeps recovery gated when third-party permissions use wildcard columns', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_wildcard_manual_recovery', projectId, tableName,
        kind: 'policy_update', baselineRevision: null,
        sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: metadataPermissions(), sourceDigest: 'a'.repeat(64),
        sourceResourceVersion: 800n, targetPolicy: null, targetColumnGrants: null,
        targetCapabilities: null, targetPermissions: [], targetDigest: permissionSnapshotDigest([]),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required', writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    const wildcardMetadata = metadata()
    wildcardMetadata.metadata.sources[0].tables[0].select_permissions[0].permission.columns = '*'
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    mocks.metadataRequest.mockResolvedValueOnce(wildcardMetadata)

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED' })
    expect(mocks.applyCommands).not.toHaveBeenCalled()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
  })

  it('does not overwrite a third-party scoped permission during automatic source restore', async () => {
    const emptyMetadata = {
      resource_version: 801,
      metadata: {
        sources: [{ name: 'default', tables: [{ table: { schema: schemaName, name: tableName } }] }],
      },
    }
    const customMetadata = {
      resource_version: 802,
      metadata: {
        sources: [{
          name: 'default',
          tables: [{
            table: { schema: schemaName, name: tableName },
            select_permissions: [{
              role: roles.authenticated,
              permission: {
                columns: ['id'],
                filter: { team_id: { _eq: 'X-Hasura-User-Id' } },
                allow_aggregations: false,
              },
            }],
          }],
        }],
      },
    }
    mocks.metadataRequest
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce(emptyMetadata)
      .mockResolvedValueOnce(customMetadata)
      .mockResolvedValueOnce(customMetadata)
    mocks.transitionPolicyOperation.mockResolvedValue({} as never)
    const input = {
      operationId: 'operation_custom_automatic_restore',
      authenticated: {
        select: 'all' as const, insert: 'none' as const, update: 'none' as const,
        delete: 'none' as const, ownerColumn: null,
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: { select: oldColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
    }

    await expect(updateManagedTablePolicy(
      projectId, tableName, input, 'usr_1', async () => ({}) as never
    )).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED' })

    expect(mocks.applyCommands).toHaveBeenCalledOnce()
    expect(mocks.replacePermissions).not.toHaveBeenCalled()
    expect(mocks.transitionPolicyOperation).toHaveBeenLastCalledWith(
      expect.anything(), input.operationId, ['applying', 'recovering'],
      expect.objectContaining({ status: 'recovery_required' })
    )
  })

  it('refuses to recover an operation after the project schema identity changes', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_old_schema', projectId, tableName, kind: 'policy_update',
        baselineRevision: null, sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: metadataPermissions(),
        targetDigest: permissionSnapshotDigest(metadataPermissions()),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    mocks.getProjectById.mockResolvedValueOnce({
      projectId, schemaName: 'dru_recreated_pitchetch', alias: 'pitchetch', dataAccessMode: 'explicit',
    })

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_RECONCILE_STALE' })
    expect(mocks.metadataRequest).not.toHaveBeenCalled()
    expect(mocks.applyCommands).not.toHaveBeenCalled()
  })

  it('rejects manual recovery when the restored source cannot be verified', async () => {
    const operation = {
      ...operationFrom({
        operationId: 'operation_failed_recovery', projectId, tableName, kind: 'policy_update',
        baselineRevision: null, sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions: [], sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: metadataPermissions(),
        targetDigest: permissionSnapshotDigest(metadataPermissions()),
        requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    mocks.metadataRequest
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(metadata())
    mocks.transitionPolicyOperation
      .mockResolvedValueOnce({ ...operation, status: 'recovering', phase: 'restore_source' })
      .mockResolvedValueOnce({ ...operation, status: 'recovery_required', phase: 'verify_source' })

    await expect(recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })).rejects.toMatchObject({
      code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
    })

    expect(mocks.transitionPolicyOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      operation.operationId,
      ['recovering'],
      expect.objectContaining({ status: 'recovery_required', phase: 'verify_source' })
    )
  })

  it('verifies a restored source permission against historical column capabilities', async () => {
    const currentColumns = ['id', 'user_id']
    mocks.getTableMetadata.mockResolvedValue({
      schemaName, tableName,
      columns: currentColumns.map((name) => ({
        name, type: 'text', nullable: true, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    const sourcePermissions = [
      {
        role: roles.authenticated, operation: 'insert' as const,
        permission: { columns: ['id', 'title'], check: ownerFilter, set: { user_id: 'X-Hasura-User-Id' } },
      },
      {
        role: roles.authenticated, operation: 'select' as const,
        permission: { columns: oldColumns, filter: ownerFilter, allow_aggregations: false },
      },
    ]
    const operation = {
      ...operationFrom({
        operationId: 'operation_historical_recovery', projectId, tableName, kind: 'reconcile',
        baselineRevision: null,
        sourceCapabilities: {
          readableColumns: oldColumns, insertableColumns: oldColumns, updateableColumns: oldColumns,
        },
        sourcePermissions, sourceDigest: 'a'.repeat(64), sourceResourceVersion: 800n,
        targetPolicy: null, targetColumnGrants: null, targetCapabilities: null,
        targetPermissions: null, targetDigest: null, requestDigest: 'b'.repeat(64), createdBy: 'usr_1',
      }),
      status: 'recovery_required',
      writeDeadlineAt: new Date(Date.now() - 10_000),
    }
    mocks.getPolicyOperationWithClient.mockResolvedValueOnce(operation)
    mocks.metadataRequest
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce({ ...metadata(), resource_version: 802 })
    mocks.transitionPolicyOperation
      .mockResolvedValueOnce({ ...operation, status: 'recovering', phase: 'restore_source' })
      .mockResolvedValueOnce({ ...operation, status: 'failed', phase: 'completed' })

    const result = await recoverPolicyOperation(projectId, operation.operationId, {
      sourceDigest: operation.sourceDigest,
      projectAlias: 'pitchetch',
    })

    expect(mocks.replacePermissions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        permissions: sourcePermissions,
        allowInconsistentMetadata: true,
      })
    )
    expect(mocks.transitionPolicyOperation).toHaveBeenLastCalledWith(
      expect.anything(),
      operation.operationId,
      ['recovering'],
      expect.objectContaining({ status: 'failed', phase: 'completed' })
    )
    expect(result.status).toBe('failed')
  })
})
