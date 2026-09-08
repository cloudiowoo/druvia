import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateManagedTablePolicy } = vi.hoisted(() => ({
  updateManagedTablePolicy: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  getTableMetadata: vi.fn(),
  trackTableInHasura: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequest: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-inventory.js', () => ({
  DataAccessInventorySchemaNotFoundError: class DataAccessInventorySchemaNotFoundError extends Error {},
  getDataAccessInventory: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: vi.fn(async (_projectId, callback) => callback()),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js', () => ({
  getManagedPolicy: vi.fn(async () => null),
  getProjectPolicyOperation: vi.fn(async () => null),
  listManagedPolicies: vi.fn(async () => []),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-policy-operation.service.js', () => ({
  updateManagedTablePolicy,
  toOperationState: vi.fn(),
}))

import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'
import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  DataAccessInventorySchemaNotFoundError,
  getDataAccessInventory,
} from '../../apps/api/src/modules/data-access/data-access-inventory.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  getManagedPolicy,
  getProjectPolicyOperation,
} from '../../apps/api/src/modules/data-access/data-access-managed-policy.repository.js'
import {
  DataAccessNotFoundError,
  DataAccessUpstreamError,
  getProjectDataAccessOverview,
  getTableDataAccess,
  updateTableDataAccess,
} from '../../apps/api/src/modules/data-access/data-access.service.js'
import type {
  TableDataAccessInput,
  TableDataAccessUpdateInput,
} from '../../apps/api/src/modules/data-access/data-access.types.js'

const projectId = 'proj_123'
const schemaName = 'dru_proj_123'
const tableName = 'orders'
const columns = ['id', 'owner_id', 'title']

const roles = {
  authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
  anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
}

function tableMetadata(permissionOverrides: Record<string, unknown> = {}) {
  return {
    sources: [{
      name: 'default',
      tables: [{
        table: { schema: schemaName, name: tableName },
        ...permissionOverrides,
      }],
    }],
  }
}

function closedPolicy(): TableDataAccessInput {
  return {
    authenticated: {
      select: 'none',
      insert: 'none',
      update: 'none',
      delete: 'none',
      ownerColumn: null,
    },
    anonymous: { select: false },
  }
}

describe('data access service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId,
      schemaName,
      dataAccessMode: 'compatibility',
    } as Awaited<ReturnType<typeof projectService.getProjectById>>)
    vi.mocked(tableService.getTableMetadata).mockResolvedValue({
      schemaName,
      tableName,
      columns: columns.map((name) => ({
        name,
        type: 'text',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: name === 'id',
        isGenerated: false,
        isIdentity: false,
        identityGeneration: null,
      })),
      rowCount: 0,
      sizeBytes: 0,
    })
    vi.mocked(tableService.trackTableInHasura).mockResolvedValue(true)
    vi.mocked(getDataAccessInventory).mockResolvedValue([{
      tableName,
      columns,
      insertableColumns: columns,
      updateableColumns: columns,
      realtimeEnabled: false,
    }])
    vi.mocked(hasuraMetadataRequest).mockResolvedValue(tableMetadata() as never)
    updateManagedTablePolicy.mockResolvedValue({ projectId, tableName } as never)
  })

  it('builds a project overview from one default-source metadata export', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [
        {
          name: 'secondary',
          tables: [{
            table: { schema: schemaName, name: tableName },
            select_permissions: [{
              role: roles.authenticated,
              permission: { columns, filter: { unexpected: true } },
            }],
          }],
        },
        {
          name: 'default',
          tables: [{
            table: { schema: schemaName, name: tableName },
            select_permissions: [{
              role: roles.authenticated,
              permission: { columns, filter: {} },
            }],
          }],
        },
      ],
    } as never)

    const overview = await getProjectDataAccessOverview(projectId)

    expect(getDataAccessInventory).toHaveBeenCalledWith(schemaName)
    expect(hasuraMetadataRequest).toHaveBeenCalledTimes(1)
    expect(hasuraMetadataRequest).toHaveBeenCalledWith('export_metadata', {})
    expect(overview.tables[0]).toMatchObject({
      tableName,
      authenticatedAccess: 'read_only',
    })
  })

  it('reports the persisted explicit project runtime mode', async () => {
    vi.mocked(projectService.getProjectById).mockResolvedValueOnce({
      projectId,
      schemaName,
      dataAccessMode: 'explicit',
    } as Awaited<ReturnType<typeof projectService.getProjectById>>)

    const overview = await getProjectDataAccessOverview(projectId)

    expect(overview.runtimeMode).toBe('explicit')
  })

  it('rejects a project overview when the default metadata source is unavailable', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{ name: 'secondary', tables: [] }],
    } as never)

    await expect(getProjectDataAccessOverview(projectId))
      .rejects.toBeInstanceOf(DataAccessUpstreamError)
  })

  it('maps a missing physical project schema to a data access not-found error', async () => {
    vi.mocked(getDataAccessInventory).mockRejectedValueOnce(
      new DataAccessInventorySchemaNotFoundError('Schema not found')
    )

    await expect(getProjectDataAccessOverview(projectId))
      .rejects.toBeInstanceOf(DataAccessNotFoundError)
  })

  it('does not inspect table access from a non-default metadata source', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'secondary',
        tables: [{
          table: { schema: schemaName, name: tableName },
          select_permissions: [{
            role: roles.authenticated,
            permission: { columns, filter: {} },
          }],
        }],
      }],
    } as never)

    await expect(getTableDataAccess(projectId, tableName))
      .rejects.toBeInstanceOf(DataAccessUpstreamError)
  })

  it('reads only managed scoped roles and reports legacy roles separately', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      select_permissions: [
        {
          role: roles.authenticated,
          permission: { columns, filter: {}, allow_aggregations: false },
        },
        {
          role: roles.anonymous,
          permission: { columns, filter: {}, allow_aggregations: false },
        },
        { role: 'user', permission: { columns: '*', filter: {} } },
        { role: 'druvia_v1_s_other_user', permission: { columns: '*', filter: {} } },
      ],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state).toMatchObject({
      projectId,
      schemaName,
      tableName,
      columns,
      managedState: 'adoption_required',
      legacyRoles: ['user'],
      policy: {
        authenticated: {
          select: 'all',
          insert: 'none',
          update: 'none',
          delete: 'none',
          ownerColumn: null,
        },
        anonymous: { select: true },
      },
    })
  })

  it('exposes a stalled metadata write as recovery-required', async () => {
    vi.mocked(getProjectPolicyOperation).mockResolvedValueOnce({
      tableName,
      status: 'applying',
      writeDeadlineAt: new Date(Date.now() - 5_001),
    } as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('recovery_required')
  })

  it('maps supported owner rules back to the logical policy', async () => {
    const ownerFilter = { owner_id: { _eq: 'X-Hasura-User-Id' } }
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns, filter: ownerFilter, allow_aggregations: false },
      }],
      insert_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: ['id', 'title'],
          check: ownerFilter,
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      }],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('adoption_required')
    expect(state.policy.authenticated).toMatchObject({
      select: 'owner',
      insert: 'owner',
      ownerColumn: 'owner_id',
    })
  })

  it('accepts Hasura-normalized defaults for managed permissions', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns, filter: {} },
      }],
      insert_permissions: [{
        role: roles.authenticated,
        permission: { columns, check: {}, set: {} },
      }],
      update_permissions: [{
        role: roles.authenticated,
        permission: { columns, filter: {}, check: null },
      }],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('adoption_required')
    expect(state.policy.authenticated).toMatchObject({
      select: 'all',
      insert: 'all',
      update: 'all',
    })
  })

  it('requires reconcile when a previously granted column is no longer readable', async () => {
    const baselineColumns = [...columns, 'retired_summary']
    const policy: TableDataAccessInput = {
      ...closedPolicy(),
      authenticated: { ...closedPolicy().authenticated, select: 'all' },
    }
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns: baselineColumns, filter: {}, allow_aggregations: false },
      }],
    }) as never)
    vi.mocked(getManagedPolicy).mockResolvedValueOnce({
      projectId,
      tableName,
      schemaName,
      policyVersion: 1,
      policy,
      columnGrants: {
        authenticated: { select: baselineColumns, insert: [], update: [] },
        anonymous: { select: [] },
      },
      capabilitiesSnapshot: {
        readableColumns: baselineColumns,
        insertableColumns: baselineColumns,
        updateableColumns: baselineColumns,
      },
      permissionsSnapshot: [{
        role: roles.authenticated,
        operation: 'select',
        permission: { columns: baselineColumns, filter: {}, allow_aggregations: false },
      }],
      metadataDigest: 'a'.repeat(64),
      revision: 1n,
      createdBy: 'usr_1',
      updatedBy: 'usr_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('refresh_required')
    expect(state.drift?.removedOrRestricted).toEqual(['retired_summary'])
  })

  it('delegates policy writes to the persisted operation state machine', async () => {
    const input: TableDataAccessUpdateInput = {
      ...closedPolicy(),
      operationId: 'operation_123',
    }
    await updateTableDataAccess(projectId, tableName, input, 'usr_1')
    expect(updateManagedTablePolicy).toHaveBeenCalledWith(
      projectId, tableName, input, 'usr_1', expect.any(Function)
    )
  })

  it('marks unsupported managed metadata as custom and refuses to overwrite it', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValue(tableMetadata({
      select_permissions: [{
        role: roles.authenticated,
        permission: { columns: ['id'], filter: { published: { _eq: true } } },
      }],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)
    expect(state.managedState).toBe('custom')

  })

  it('treats owner write permissions with wildcard columns as custom', async () => {
    const ownerFilter = { owner_id: { _eq: 'X-Hasura-User-Id' } }
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      insert_permissions: [{
        role: roles.authenticated,
        permission: {
          columns: '*',
          check: ownerFilter,
          set: { owner_id: 'X-Hasura-User-Id' },
        },
      }],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('custom')
  })

  it('treats additional managed permission presets as custom', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce(tableMetadata({
      update_permissions: [{
        role: roles.authenticated,
        permission: {
          columns,
          filter: {},
          check: null,
          set: { owner_id: 'fixed-owner' },
        },
      }],
    }) as never)

    const state = await getTableDataAccess(projectId, tableName)

    expect(state.managedState).toBe('custom')
  })

  it('reports missing projects and tables explicitly', async () => {
    vi.mocked(projectService.getProjectById).mockResolvedValueOnce(null)
    await expect(getTableDataAccess(projectId, tableName))
      .rejects.toBeInstanceOf(DataAccessNotFoundError)

    vi.mocked(tableService.getTableMetadata).mockResolvedValueOnce(null)
    await expect(getTableDataAccess(projectId, tableName))
      .rejects.toBeInstanceOf(DataAccessNotFoundError)
  })

  it.each([
    'Hasura failed: {"error":"authorization: Bearer bearer-secret-marker","code":"permission-error"}',
    'Hasura failed: {"error":"{\\"token\\":\\"json-secret-marker\\"}","code":"permission-error"}',
    'transport failed with password=password-secret-marker',
  ])('redacts credentials from captured upstream diagnostics', (message) => {
    const error = new DataAccessUpstreamError(
      'Unable to update data access metadata',
      { operation: 'update_permissions', projectId, schemaName, tableName },
      new Error(message)
    )

    expect(error.upstreamMessage).toContain('[REDACTED]')
    expect(error.upstreamMessage).not.toContain('secret-marker')
  })
})
