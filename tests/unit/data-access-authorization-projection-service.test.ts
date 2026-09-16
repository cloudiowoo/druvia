import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getTableMetadata: vi.fn(),
  metadataRequest: vi.fn(),
  withLock: vi.fn(),
  getManagedPolicyWithClient: vi.fn(),
  saveManagedPolicy: vi.fn(),
  supersedePolicyPreviews: vi.fn(),
  createOperation: vi.fn(),
  getOperationWithClient: vi.fn(),
  getFailClosedOperationWithClient: vi.fn(),
  claimLatestCompletedRecovery: vi.fn(),
  transitionOperation: vi.fn(),
  supersedeProjectionPreviews: vi.fn(),
  loadDependencies: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: mocks.getProjectById,
}))
vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  getTableMetadata: mocks.getTableMetadata,
}))
vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequestWithOptions: mocks.metadataRequest,
  HasuraMetadataRequestError: class HasuraMetadataRequestError extends Error {
    isDefinitiveRejection = false
  },
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: mocks.withLock,
}))
vi.mock('../../apps/api/src/modules/data-access/data-scope-role.js', () => ({
  resolveDataScopeRole: ({ actor }: { actor: string }) => actor === 'authenticated'
    ? 'druvia_v1_s_4b5_user'
    : 'druvia_v1_s_4b5_anon',
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js', () => ({
  getManagedPolicyWithClient: mocks.getManagedPolicyWithClient,
  saveManagedPolicy: mocks.saveManagedPolicy,
  supersedePolicyPreviews: mocks.supersedePolicyPreviews,
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-projection-operation.repository.js', () => ({
  createProjectionOperation: mocks.createOperation,
  getProjectionOperationWithClient: mocks.getOperationWithClient,
  getEffectiveFailClosedProjectionOperationWithClient: mocks.getFailClosedOperationWithClient,
  claimLatestCompletedProjectionRecovery: mocks.claimLatestCompletedRecovery,
  transitionProjectionOperation: mocks.transitionOperation,
  supersedeProjectionPreviews: mocks.supersedeProjectionPreviews,
  renewProjectionOperationWriterLease: vi.fn(),
  ProjectionOperationWriterLeaseError: class ProjectionOperationWriterLeaseError extends Error {},
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-authorization-projection.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../apps/api/src/modules/data-access/data-access-authorization-projection.js')>()
  return { ...original, loadAuthorizationProjectionDependencies: mocks.loadDependencies }
})

import {
  applyAuthorizationProjection,
  previewAuthorizationProjection,
  recoverAuthorizationProjection,
} from '../../apps/api/src/modules/data-access/data-access-authorization-projection.service.js'
import { HasuraMetadataRequestError } from '../../apps/api/src/modules/realtime/realtime.service.js'

const sourceMetadata = {
  version: 3,
  sources: [{ name: 'default', tables: [{
    table: { schema: 'dru_default_test', name: 'orders' },
    select_permissions: [{
      role: 'druvia_v1_s_4b5_user',
      permission: {
        columns: ['id', 'user_id'],
        filter: { user_id: { _eq: 'X-Hasura-User-Id' } },
        allow_aggregations: false,
      },
    }],
  }] }],
}
const contract = {
  contractVersion: 1,
  policyVersion: 2,
  view: {
    name: 'access_projection', projectionMode: 'sparse_allow_list',
    key: ['id', 'user_id'], columns: { id: 'uuid', user_id: 'uuid', allowed: 'boolean' },
    clientPermissions: { select: false, insert: false, update: false, delete: false },
  },
  relationships: [{
    table: 'orders', name: 'access_projection', type: 'object',
    mapping: { id: 'id', user_id: 'user_id' }, ownerColumn: 'user_id',
    actorColumn: 'user_id', allowColumn: 'allowed',
  }],
} as const
const baseline = {
  projectId: 'proj_1', schemaName: 'dru_default_test', tableName: 'orders', policyVersion: 1,
  policy: {
    policyVersion: 1,
    authenticated: {
      select: 'owner', insert: 'none', update: 'none', delete: 'none', ownerColumn: 'user_id',
    },
    anonymous: { select: false },
  },
  columnGrants: {
    authenticated: { select: ['id', 'user_id'], insert: [], update: [] },
    anonymous: { select: [] },
  },
  capabilitiesSnapshot: {
    readableColumns: ['id', 'user_id'], insertableColumns: ['id', 'user_id'],
    updateableColumns: ['id', 'user_id'],
  },
  permissionsSnapshot: [{
    role: 'druvia_v1_s_4b5_user', operation: 'select',
    permission: {
      columns: ['id', 'user_id'], filter: { user_id: { _eq: 'X-Hasura-User-Id' } },
      allow_aggregations: false,
    },
  }],
  metadataDigest: '0'.repeat(64), dependencySnapshot: null, dependencyDigest: null,
  revision: 2n, createdBy: 'usr_1', updatedBy: 'usr_1',
  createdAt: new Date(), updatedAt: new Date(),
}

describe('authorization projection service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const client = { query: vi.fn(async () => ({ rows: [] })) }
    mocks.withLock.mockImplementation(async (_id, callback) => callback(client))
    mocks.getProjectById.mockResolvedValue({
      projectId: 'proj_1', schemaName: 'dru_default_test', alias: 'test',
    })
    mocks.getManagedPolicyWithClient.mockResolvedValue(baseline)
    mocks.getTableMetadata.mockResolvedValue({
      schemaName: 'dru_default_test', tableName: 'orders',
      columns: ['id', 'user_id'].map((name) => ({
        name, type: 'uuid', nullable: false, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    mocks.getFailClosedOperationWithClient.mockResolvedValue(null)
    mocks.loadDependencies.mockResolvedValue({
      projectDbUser: 'dru_default_test_user',
      snapshot: { schemaName: 'dru_default_test', relationships: [], digest: 'a'.repeat(64) },
    })
    mocks.createOperation.mockImplementation(async (_client, value) => ({
      ...value, status: 'preview_ready', phase: 'preview', targetResourceVersion: null,
      writerEpoch: null, writeDeadlineAt: null, error: null, createdAt: new Date(),
      startedAt: null, completedAt: null, updatedAt: new Date(),
    }))
    mocks.claimLatestCompletedRecovery.mockImplementation(async (
      _client, _projectId, _operationId, writerEpoch, writeDeadlineAt
    ) => ({
      status: 'recovering', writerEpoch, writeDeadlineAt,
    }))
  })

  it('previews and applies all projection metadata with one replace_metadata request', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    const preview = await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const operation = await mocks.createOperation.mock.results[0].value
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    mocks.metadataRequest
      .mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
      .mockResolvedValueOnce({ message: 'success' })
      .mockResolvedValueOnce({ resource_version: 8, metadata: operation.targetMetadata })

    await applyAuthorizationProjection('proj_1', operation.operationId, {
      projectAlias: 'test', sourceDigest: preview.sourceDigest,
      targetDigest: preview.targetDigest, dependencyDigest: preview.dependencyDigest,
      baselineRevisions: { orders: '2' },
    })

    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'replace_metadata',
      { allow_inconsistent_metadata: false, metadata: operation.targetMetadata },
      expect.objectContaining({ resourceVersion: 7n })
    )
    expect(mocks.metadataRequest.mock.calls.filter(([type]) => type === 'replace_metadata')).toHaveLength(1)
    expect(mocks.saveManagedPolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      policy: expect.objectContaining({ policyVersion: 2 }),
      dependencyDigest: 'a'.repeat(64), expectedRevision: 2n,
    }))
  })

  it('treats an omitted Hasura false aggregation default as the managed baseline', async () => {
    const exportedMetadata = structuredClone(sourceMetadata)
    delete exportedMetadata.sources[0].tables[0].select_permissions[0].permission.allow_aggregations
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: exportedMetadata })

    await expect(previewAuthorizationProjection('proj_1', contract, 'usr_1'))
      .resolves.toMatchObject({ status: 'preview_ready' })
  })

  it('rejects a contract that omits an existing v2 managed table', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ table_name: 'archived_orders' }] })),
    }
    mocks.withLock.mockImplementationOnce(async (_id, callback) => callback(client))

    await expect(previewAuthorizationProjection('proj_1', contract, 'usr_1'))
      .rejects.toMatchObject({ code: 'INVALID_DATA_ACCESS_PROJECTION' })
    expect(mocks.metadataRequest).not.toHaveBeenCalled()
  })

  it('rejects projection preview until column capability drift is reconciled', async () => {
    mocks.getTableMetadata.mockResolvedValueOnce({
      schemaName: 'dru_default_test', tableName: 'orders',
      columns: ['id', 'user_id', 'new_column'].map((name) => ({
        name, type: 'uuid', nullable: false, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })

    await expect(previewAuthorizationProjection('proj_1', contract, 'usr_1'))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.createOperation).not.toHaveBeenCalled()
  })

  it('reports a definitive Hasura rejection without requiring recovery', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    const preview = await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const operation = await mocks.createOperation.mock.results[0].value
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    const rejection = new HasuraMetadataRequestError('rejected')
    rejection.isDefinitiveRejection = true
    mocks.metadataRequest
      .mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
      .mockRejectedValueOnce(rejection)

    await expect(applyAuthorizationProjection('proj_1', operation.operationId, {
      projectAlias: 'test', sourceDigest: preview.sourceDigest,
      targetDigest: preview.targetDigest, dependencyDigest: preview.dependencyDigest,
      baselineRevisions: { orders: '2' },
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_REJECTED' })
    expect(mocks.transitionOperation).toHaveBeenCalledWith(
      expect.anything(), operation.operationId, ['applying'],
      expect.objectContaining({ status: 'failed' })
    )
  })

  it('rejects apply when any metadata changed after preview', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    const preview = await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const operation = await mocks.createOperation.mock.results[0].value
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 8, metadata: sourceMetadata })

    await expect(applyAuthorizationProjection('proj_1', operation.operationId, {
      projectAlias: 'test', sourceDigest: preview.sourceDigest,
      targetDigest: preview.targetDigest, dependencyDigest: preview.dependencyDigest,
      baselineRevisions: { orders: '2' },
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.metadataRequest.mock.calls.some(([type]) => type === 'replace_metadata')).toBe(false)
  })

  it('rejects apply when table capabilities changed after preview', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    const preview = await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const operation = await mocks.createOperation.mock.results[0].value
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    mocks.getTableMetadata.mockResolvedValueOnce({
      schemaName: 'dru_default_test', tableName: 'orders',
      columns: ['id', 'user_id', 'new_column'].map((name) => ({
        name, type: 'uuid', nullable: false, defaultValue: null,
        isPrimaryKey: name === 'id', isGenerated: false, isIdentity: false,
        identityGeneration: null,
      })),
    })

    await expect(applyAuthorizationProjection('proj_1', operation.operationId, {
      projectAlias: 'test', sourceDigest: preview.sourceDigest,
      targetDigest: preview.targetDigest, dependencyDigest: preview.dependencyDigest,
      baselineRevisions: { orders: '2' },
    })).rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.metadataRequest.mock.calls.some(([type]) => type === 'replace_metadata')).toBe(false)
  })

  it('does not recover an operation while its metadata writer lease is active', async () => {
    const operation = {
      ...(await mocks.createOperation({}, {
        operationId: 'dapo_active', projectId: 'proj_1', schemaName: 'dru_default_test',
        contract, baselineRevisions: { orders: '2' }, sourceMetadata, targetMetadata: sourceMetadata,
        dependencySnapshot: { digest: 'a'.repeat(64) }, dependencyDigest: 'a'.repeat(64),
        sourceDigest: 'b'.repeat(64), targetDigest: 'c'.repeat(64),
        sourceResourceVersion: 7n, requestDigest: 'd'.repeat(64), createdBy: 'usr_1',
      })),
      status: 'applying' as const,
      writeDeadlineAt: new Date(Date.now() + 30_000),
      startedAt: new Date(),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.transitionOperation).not.toHaveBeenCalled()
  })

  it('does not recover an unknown write result before its drain window', async () => {
    const operation = {
      ...(await mocks.createOperation({}, {
        operationId: 'dapo_unknown', projectId: 'proj_1', schemaName: 'dru_default_test',
        contract, baselineRevisions: { orders: '2' }, sourceMetadata, targetMetadata: sourceMetadata,
        dependencySnapshot: { digest: 'a'.repeat(64) }, dependencyDigest: 'a'.repeat(64),
        sourceDigest: 'b'.repeat(64), targetDigest: 'c'.repeat(64),
        sourceResourceVersion: 7n, requestDigest: 'd'.repeat(64), createdBy: 'usr_1',
      })),
      status: 'recovery_required' as const,
      writeDeadlineAt: new Date(Date.now() + 30_000),
      startedAt: new Date(),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.transitionOperation).not.toHaveBeenCalled()
  })

  it('allows a new batch preview after fail-closed provenance survives a superseded preview', async () => {
    const failClosedMetadata = structuredClone(sourceMetadata)
    delete failClosedMetadata.sources[0].tables[0].select_permissions
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 9, metadata: failClosedMetadata })
    mocks.getFailClosedOperationWithClient.mockResolvedValue({
      operationId: 'dapo_failed', projectId: 'proj_1', schemaName: 'dru_default_test',
      status: 'failed', phase: 'completed', contract, baselineRevisions: { orders: '2' },
      sourceMetadata, targetMetadata: sourceMetadata,
      dependencySnapshot: { digest: 'a'.repeat(64) }, dependencyDigest: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64), targetDigest: 'c'.repeat(64),
      sourceResourceVersion: 7n, targetResourceVersion: null,
      requestDigest: 'd'.repeat(64), writerEpoch: null, writeDeadlineAt: null,
      createdBy: 'usr_1',
      error: {
        code: 'DATA_ACCESS_PROJECTION_FAILED_CLOSED',
        message: 'Authenticated select was disabled',
      },
      createdAt: new Date(), startedAt: new Date(), completedAt: new Date(), updatedAt: new Date(),
    })

    await expect(previewAuthorizationProjection('proj_1', contract, 'usr_1'))
      .resolves.toMatchObject({ status: 'preview_ready' })
  })

  it('fails closed when target metadata exists but its projection dependency drifted', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'recovery_required' as const,
      writeDeadlineAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
      error: { code: 'DATA_ACCESS_PROJECTION_RECOVERY_REQUIRED', message: 'unknown result' },
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    mocks.loadDependencies.mockRejectedValueOnce(new Error('view definition drifted'))
    let closedMetadata: Record<string, unknown> | undefined
    mocks.metadataRequest.mockImplementation(async (type, args) => {
      if (type === 'export_metadata') {
        return closedMetadata
          ? { resource_version: 9, metadata: closedMetadata }
          : { resource_version: 8, metadata: operation.targetMetadata }
      }
      closedMetadata = args.metadata
      return { message: 'success' }
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'replace_metadata',
      expect.objectContaining({ allow_inconsistent_metadata: false }),
      expect.objectContaining({ resourceVersion: 8n })
    )
    expect(mocks.transitionOperation).toHaveBeenLastCalledWith(
      expect.anything(), operation.operationId, ['recovering'],
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'DATA_ACCESS_PROJECTION_FAILED_CLOSED' }),
      })
    )
  })

  it('allows a completed batch with dependency drift to fail closed', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'completed' as const,
      targetMetadata: previewOperation.targetMetadata,
      targetDigest: previewOperation.targetDigest,
      targetResourceVersion: 8n,
      completedAt: new Date(),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    mocks.loadDependencies.mockRejectedValueOnce(new Error('view security properties drifted'))
    let closedMetadata: Record<string, unknown> | undefined
    mocks.metadataRequest.mockImplementation(async (type, args) => {
      if (type === 'export_metadata') {
        return closedMetadata
          ? { resource_version: 10, metadata: closedMetadata }
          : { resource_version: 9, metadata: operation.targetMetadata }
      }
      closedMetadata = args.metadata
      return { message: 'success' }
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.claimLatestCompletedRecovery).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', operation.operationId,
      expect.any(String), expect.any(Date)
    )
  })

  it('fails closed when a completed batch metadata drifted back to its source snapshot', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'completed' as const,
      targetResourceVersion: 8n,
      completedAt: new Date(),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    let closedMetadata: Record<string, unknown> | undefined
    mocks.metadataRequest.mockImplementation(async (type, args) => {
      if (type === 'export_metadata') {
        return closedMetadata
          ? { resource_version: 10, metadata: closedMetadata }
          : { resource_version: 9, metadata: operation.sourceMetadata }
      }
      closedMetadata = args.metadata
      return { message: 'success' }
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'replace_metadata',
      expect.objectContaining({ allow_inconsistent_metadata: false }),
      expect.objectContaining({ resourceVersion: 9n })
    )
    expect(mocks.transitionOperation).toHaveBeenLastCalledWith(
      expect.anything(), operation.operationId, ['recovering'],
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'DATA_ACCESS_PROJECTION_FAILED_CLOSED' }),
      })
    )
  })

  it('fails closed when an uncertain write returned to source metadata at a newer resource version', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'recovery_required' as const,
      writeDeadlineAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    let closedMetadata: Record<string, unknown> | undefined
    mocks.metadataRequest.mockImplementation(async (type, args) => {
      if (type === 'export_metadata') {
        return closedMetadata
          ? { resource_version: 10, metadata: closedMetadata }
          : { resource_version: 9, metadata: operation.sourceMetadata }
      }
      closedMetadata = args.metadata
      return { message: 'success' }
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'replace_metadata',
      expect.objectContaining({ allow_inconsistent_metadata: false }),
      expect.objectContaining({ resourceVersion: 9n })
    )
    expect(mocks.transitionOperation).toHaveBeenLastCalledWith(
      expect.anything(), operation.operationId, ['recovering'],
      expect.objectContaining({
        error: expect.objectContaining({ code: 'DATA_ACCESS_PROJECTION_FAILED_CLOSED' }),
      })
    )
  })

  it('fails closed when restored target metadata grants exceed a reconciled v2 baseline', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'completed' as const,
      targetResourceVersion: 8n,
      completedAt: new Date(),
    }
    const reconciled = {
      ...baseline, policyVersion: 2,
      dependencyDigest: operation.dependencyDigest,
      columnGrants: {
        ...baseline.columnGrants,
        authenticated: { ...baseline.columnGrants.authenticated, select: ['user_id'] },
      },
      permissionsSnapshot: [{
        role: 'druvia_v1_s_4b5_user', operation: 'select',
        permission: {
          columns: ['user_id'],
          filter: { _and: [
            { user_id: { _eq: 'X-Hasura-User-Id' } },
            { access_projection: {
              user_id: { _eq: 'X-Hasura-User-Id' }, allowed: { _eq: true },
            } },
          ] },
          allow_aggregations: false,
        },
      }],
    }
    mocks.getManagedPolicyWithClient.mockResolvedValue(reconciled)
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    let closedMetadata: Record<string, unknown> | undefined
    mocks.metadataRequest.mockImplementation(async (type, args) => {
      if (type === 'export_metadata') {
        return closedMetadata
          ? { resource_version: 10, metadata: closedMetadata }
          : { resource_version: 9, metadata: operation.targetMetadata }
      }
      closedMetadata = args.metadata
      return { message: 'success' }
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.metadataRequest).toHaveBeenCalledWith(
      'replace_metadata',
      expect.objectContaining({ allow_inconsistent_metadata: false }),
      expect.objectContaining({ resourceVersion: 9n })
    )
    expect(mocks.saveManagedPolicy).not.toHaveBeenCalled()
  })

  it('treats an uncertain write as not applied only when source metadata and version both remain unchanged', async () => {
    mocks.metadataRequest.mockResolvedValueOnce({ resource_version: 7, metadata: sourceMetadata })
    await previewAuthorizationProjection('proj_1', contract, 'usr_1')
    const previewOperation = await mocks.createOperation.mock.results[0].value
    const operation = {
      ...previewOperation,
      status: 'recovery_required' as const,
      writeDeadlineAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.transitionOperation.mockImplementation(async (_client, _id, _statuses, patch) => ({
      ...operation, ...patch,
    }))
    mocks.metadataRequest.mockResolvedValue({
      resource_version: 7, metadata: operation.sourceMetadata,
    })

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .resolves.toMatchObject({ status: 'failed' })
    expect(mocks.metadataRequest.mock.calls.some(([type]) => type === 'replace_metadata')).toBe(false)
    expect(mocks.transitionOperation).toHaveBeenLastCalledWith(
      expect.anything(), operation.operationId, ['recovering'],
      expect.objectContaining({
        error: expect.objectContaining({ code: 'DATA_ACCESS_PROJECTION_NOT_APPLIED' }),
      })
    )
  })

  it('rejects recovery of an obsolete completed batch', async () => {
    const operation = {
      ...(await mocks.createOperation({}, {
        operationId: 'dapo_old', projectId: 'proj_1', schemaName: 'dru_default_test',
        contract, baselineRevisions: { orders: '2' }, sourceMetadata,
        targetMetadata: sourceMetadata, dependencySnapshot: { digest: 'a'.repeat(64) },
        dependencyDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
        targetDigest: 'c'.repeat(64), sourceResourceVersion: 7n,
        requestDigest: 'd'.repeat(64), createdBy: 'usr_1',
      })),
      status: 'completed' as const,
      completedAt: new Date(),
    }
    mocks.getOperationWithClient.mockResolvedValue(operation)
    mocks.claimLatestCompletedRecovery.mockResolvedValueOnce(null)

    await expect(recoverAuthorizationProjection('proj_1', operation.operationId, 'test'))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })
    expect(mocks.metadataRequest).not.toHaveBeenCalled()
  })
})
