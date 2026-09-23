import { beforeEach, describe, expect, it, vi } from 'vitest'

const policyOperationMocks = vi.hoisted(() => ({
  previewPolicyReconcile: vi.fn(),
  applyPolicyReconcile: vi.fn(),
  recoverPolicyOperation: vi.fn(),
}))
const projectionMocks = vi.hoisted(() => ({
  previewAuthorizationProjection: vi.fn(),
  applyAuthorizationProjection: vi.fn(),
  recoverAuthorizationProjection: vi.fn(),
  getActiveAuthorizationProjection: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access.service.js', () => ({
  DataAccessConflictError: class DataAccessConflictError extends Error {},
  DataAccessNotFoundError: class DataAccessNotFoundError extends Error {},
  DataAccessUpstreamError: class DataAccessUpstreamError extends Error {},
  getProjectDataAccessOverview: vi.fn(),
  getTableDataAccess: vi.fn(),
  updateTableDataAccess: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-policy-operation.service.js', () => ({
  DataAccessPolicyOperationError: class DataAccessPolicyOperationError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
    }
  },
  applyPolicyAdoption: vi.fn(),
  applyPolicyReconcile: policyOperationMocks.applyPolicyReconcile,
  getActivePolicyOperation: vi.fn(),
  previewPolicyAdoption: vi.fn(),
  previewPolicyReconcile: policyOperationMocks.previewPolicyReconcile,
  recoverPolicyOperation: policyOperationMocks.recoverPolicyOperation,
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-authorization-projection.service.js', () => ({
  AuthorizationProjectionOperationError: class AuthorizationProjectionOperationError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
    }
  },
  ...projectionMocks,
}))

import * as controller from '../../apps/api/src/modules/data-access/data-access.controller.js'
import * as service from '../../apps/api/src/modules/data-access/data-access.service.js'
import { checkProjectAccess } from '../../apps/api/src/lib/access.js'
import { DataAccessValidationError } from '../../apps/api/src/modules/data-access/data-access-policy.js'
import { DataAccessPolicyOperationError } from '../../apps/api/src/modules/data-access/data-access-policy-operation.service.js'
import { createClosedTableDataAccessPolicy } from '../../apps/api/src/modules/data-access/data-access-policy.js'

function createReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
    statusCode: 200,
    payload: undefined as unknown,
  }
  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code
    return reply
  })
  reply.send.mockImplementation((payload: unknown) => {
    reply.payload = payload
    return reply
  })
  return reply
}

const policy = {
  policyVersion: 1 as const,
  authenticated: {
    select: 'all' as const,
    insert: 'none' as const,
    update: 'none' as const,
    delete: 'none' as const,
    ownerColumn: null,
  },
  anonymous: { select: false },
}

describe('data access controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(service.getProjectDataAccessOverview).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      runtimeMode: 'compatibility',
      summary: {
        totalTables: 0,
        configuredTables: 0,
        anonymousConfiguredTables: 0,
        realtimeAccessRequiredTables: 0,
        legacyTables: 0,
        reviewRequiredTables: 0,
      },
      tables: [],
    })
    vi.mocked(service.getTableDataAccess).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      tableName: 'orders',
      columns: ['id'],
      policy,
      managedState: 'managed',
      legacyRoles: [],
    })
    vi.mocked(service.updateTableDataAccess).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      tableName: 'orders',
      columns: ['id'],
      policy,
      managedState: 'managed',
      legacyRoles: [],
    })
  })

  it('allows a platform user with project access to read the project overview', async () => {
    const reply = createReply()
    await controller.getProjectDataAccessOverview({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(checkProjectAccess).toHaveBeenCalledWith('usr_123', 'proj_123')
    expect(service.getProjectDataAccessOverview).toHaveBeenCalledWith('proj_123')
    expect(reply.payload).toMatchObject({
      success: true,
      data: { runtimeMode: 'compatibility' },
    })
  })

  it('maps missing project overviews to 404', async () => {
    vi.mocked(service.getProjectDataAccessOverview).mockRejectedValueOnce(
      new service.DataAccessNotFoundError('Project or project schema not found')
    )
    const reply = createReply()
    await controller.getProjectDataAccessOverview({
      params: { projectId: 'missing' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(404)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'DATA_ACCESS_NOT_FOUND' },
    })
  })

  it('sanitizes project overview upstream failures', async () => {
    vi.mocked(service.getProjectDataAccessOverview).mockRejectedValueOnce(
      new service.DataAccessUpstreamError('admin_secret=server-value')
    )
    const reply = createReply()
    await controller.getProjectDataAccessOverview({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(502)
    expect(JSON.stringify(reply.payload)).not.toContain('server-value')
  })

  it('sanitizes project access lookup failures', async () => {
    vi.mocked(checkProjectAccess).mockRejectedValueOnce(
      new Error('password=database-secret')
    )
    const reply = createReply()

    await controller.getProjectDataAccessOverview({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(500)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'DATA_ACCESS_FAILED' },
    })
    expect(JSON.stringify(reply.payload)).not.toContain('database-secret')
  })

  it('allows a platform user with project access to read policy', async () => {
    const reply = createReply()
    await controller.getTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(checkProjectAccess).toHaveBeenCalledWith('usr_123', 'proj_123')
    expect(reply.payload).toMatchObject({ success: true, data: { tableName: 'orders' } })
  })

  it('round-trips the default v1 GET policy through PUT without an unsupported constraint field', async () => {
    vi.mocked(service.getTableDataAccess).mockResolvedValueOnce({
      projectId: 'proj_123', schemaName: 'dru_proj_123', tableName: 'orders', columns: ['id'],
      policy: createClosedTableDataAccessPolicy(), managedState: 'managed', legacyRoles: [],
    })
    const readReply = createReply()
    await controller.getTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, readReply as never)
    const returned = (readReply.payload as { data: { policy: typeof policy } }).data.policy
    expect(returned.authenticated).not.toHaveProperty('selectConstraint')

    const writeReply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: { ...returned, operationId: 'op-roundtrip' },
    } as never, writeReply as never)
    expect(writeReply.statusCode).toBe(200)
    expect(service.updateTableDataAccess).toHaveBeenCalledWith(
      'proj_123', 'orders', expect.objectContaining({ policyVersion: 1 }), 'usr_123'
    )
  })

  it.each([
    { kind: 'project_user', sub: 'pusr_1', projectId: 'proj_123' },
    {
      kind: 'apikey', projectId: 'proj_123', role: 'anon',
      apiKeyId: 42, apiKeyPrefix: 'dru_fixture1',
    },
  ])('rejects non-platform management identity $kind', async (user) => {
    const reply = createReply()
    await controller.getTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user,
    } as never, reply as never)

    expect(reply.statusCode).toBe(401)
    expect(service.getTableDataAccess).not.toHaveBeenCalled()
  })

  it('rejects platform users without project access', async () => {
    vi.mocked(checkProjectAccess).mockResolvedValueOnce(false)
    const reply = createReply()
    await controller.getTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_other', uid: 2 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(service.getTableDataAccess).not.toHaveBeenCalled()
  })

  it('rejects invalid policy input before calling the service', async () => {
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: {
        ...policy,
        authenticated: { ...policy.authenticated, select: 'custom' },
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(service.updateTableDataAccess).not.toHaveBeenCalled()
  })

  it('rejects unknown nested v2 policy fields before calling the service', async () => {
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: {
        ...policy,
        policyVersion: 2,
        authenticated: {
          ...policy.authenticated,
          select: 'owner',
          ownerColumn: 'owner_id',
          selectConstraint: {
            type: 'authorization_projection',
            relationshipPath: ['session_access_projection'],
            actorColumn: 'user_id',
            allowColumn: 'can_read_basic',
            arbitraryHasuraFilter: {},
          },
        },
        unexpected: true,
        operationId: 'operation_123',
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(service.updateTableDataAccess).not.toHaveBeenCalled()
  })

  it('passes the fixed environment-scoped constraint through the v2 policy envelope', async () => {
    const body = {
      ...policy, policyVersion: 2, operationId: 'operation_123',
      authenticated: {
        ...policy.authenticated, select: 'owner', ownerColumn: 'owner_id',
        selectConstraint: {
          type: 'authorization_projection', relationshipPath: ['session_access_projection'],
          actorColumn: 'user_id', allowColumn: 'can_read_basic', environmentColumn: 'allowed_environments',
        },
      },
    }
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 }, body,
    } as never, reply as never)
    expect(service.updateTableDataAccess).toHaveBeenCalledWith('proj_123', 'orders', body, 'usr_123')
  })

  it('rejects v1 policies that explicitly include a projection constraint field', async () => {
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: {
        ...policy,
        authenticated: { ...policy.authenticated, selectConstraint: null },
        operationId: 'operation_123',
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(service.updateTableDataAccess).not.toHaveBeenCalled()
  })

  it('maps managed metadata conflicts to 409', async () => {
    vi.mocked(service.updateTableDataAccess).mockRejectedValueOnce(
      new service.DataAccessConflictError('custom metadata')
    )
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: { ...policy, operationId: 'operation_123' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(409)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'DATA_ACCESS_CONFLICT' },
    })
  })

  it('maps semantic policy validation failures to 400', async () => {
    vi.mocked(service.updateTableDataAccess).mockRejectedValueOnce(
      new DataAccessValidationError('Owner column does not exist in the table')
    )
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: { ...policy, operationId: 'operation_123' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'INVALID_DATA_ACCESS_POLICY' },
    })
  })

  it('maps upstream failures to a sanitized 502 response', async () => {
    const upstreamError = Object.assign(
      new service.DataAccessUpstreamError('Data access metadata update failed'),
      {
        operation: 'update_permissions',
        upstreamCode: 'permission-error',
        upstreamMessage: 'Column "observed_at" is not insertable',
      }
    )
    vi.mocked(service.getTableDataAccess).mockRejectedValueOnce(upstreamError)
    const reply = createReply()
    const log = { error: vi.fn() }
    await controller.getTableDataAccess({
      id: 'req-123',
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      log,
    } as never, reply as never)

    expect(reply.statusCode).toBe(502)
    expect(JSON.stringify(reply.payload)).not.toContain('server-value')
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-123',
        projectId: 'proj_123',
        tableName: 'orders',
        operation: 'update_permissions',
        upstreamCode: 'permission-error',
        upstreamMessage: 'Column "observed_at" is not insertable',
      }),
      'Data access upstream request failed'
    )
  })

  it('sanitizes unexpected update failures as 500 responses', async () => {
    vi.mocked(service.updateTableDataAccess).mockRejectedValueOnce(
      new Error('password=database-secret')
    )
    const reply = createReply()
    await controller.updateTableDataAccess({
      params: { projectId: 'proj_123', tableName: 'orders' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      body: { ...policy, operationId: 'operation_123' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(500)
    expect(JSON.stringify(reply.payload)).not.toContain('database-secret')
  })

  it('forwards an explicit reconcile target policy', async () => {
    policyOperationMocks.previewPolicyReconcile.mockResolvedValueOnce({ policy })
    const reply = createReply()

    await controller.previewPolicyReconcile({
      params: { projectId: 'proj_123', tableName: 'orders' },
      body: { policy },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(policyOperationMocks.previewPolicyReconcile).toHaveBeenCalledWith(
      'proj_123', 'orders', 'usr_123', { policy }
    )
    expect(reply.payload).toMatchObject({ success: true, data: { policy } })
  })

  it('maps reconcile preview semantic validation failures to 400', async () => {
    policyOperationMocks.previewPolicyReconcile.mockRejectedValueOnce(
      new DataAccessValidationError('Owner column does not exist in the table')
    )
    const reply = createReply()

    await controller.previewPolicyReconcile({
      params: { projectId: 'proj_123', tableName: 'orders' },
      body: { policy },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'INVALID_DATA_ACCESS_POLICY' },
    })
  })

  it('rejects reconcile apply without the previewed target policy', async () => {
    const reply = createReply()

    await controller.applyPolicyReconcile({
      params: { projectId: 'proj_123', tableName: 'orders' },
      body: {
        operationId: 'operation_123',
        sourceDigest: 'a'.repeat(64),
        targetDigest: 'b'.repeat(64),
        baselineRevision: 1,
        projectAlias: 'pitchetch',
        columnGrants: {
          authenticated: { select: [], insert: [], update: [] },
          anonymous: { select: [] },
        },
      },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(policyOperationMocks.applyPolicyReconcile).not.toHaveBeenCalled()
  })

  it('returns a conflict when recovery cannot verify the source', async () => {
    policyOperationMocks.recoverPolicyOperation.mockRejectedValueOnce(
      new DataAccessPolicyOperationError(
        'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
        'Unable to verify restored permissions'
      )
    )
    const reply = createReply()

    await controller.recoverPolicyOperation({
      params: { projectId: 'proj_123', operationId: 'operation_123' },
      body: { sourceDigest: 'a'.repeat(64), projectAlias: 'pitchetch' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(409)
    expect(reply.payload).toMatchObject({
      success: false,
      error: { code: 'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED' },
    })
  })

  it('forwards a strict authorization projection preview contract', async () => {
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
    }
    projectionMocks.previewAuthorizationProjection.mockResolvedValueOnce({ operationId: 'dapo_1' })
    const reply = createReply()
    await controller.previewAuthorizationProjection({
      params: { projectId: 'proj_123' }, body: { contract },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(projectionMocks.previewAuthorizationProjection).toHaveBeenCalledWith(
      'proj_123', contract, 'usr_123'
    )
    expect(reply.payload).toMatchObject({ success: true, data: { operationId: 'dapo_1' } })
  })

  it('rejects unknown authorization projection envelope fields', async () => {
    const reply = createReply()
    await controller.previewAuthorizationProjection({
      params: { projectId: 'proj_123' }, body: { contract: {}, sql: 'select true' },
      user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(projectionMocks.previewAuthorizationProjection).not.toHaveBeenCalled()
  })
})
