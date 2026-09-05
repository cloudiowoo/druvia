import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'
import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  DataAccessInventorySchemaNotFoundError,
  getDataAccessInventory,
} from '../../apps/api/src/modules/data-access/data-access-inventory.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  DataAccessConflictError,
  DataAccessNotFoundError,
  DataAccessUpstreamError,
  getProjectDataAccessOverview,
  getTableDataAccess,
  updateTableDataAccess,
} from '../../apps/api/src/modules/data-access/data-access.service.js'
import type { TableDataAccessInput } from '../../apps/api/src/modules/data-access/data-access.types.js'

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

    expect(state).toEqual({
      projectId,
      schemaName,
      tableName,
      columns,
      managedState: 'managed',
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

    expect(state.managedState).toBe('managed')
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

    expect(state.managedState).toBe('managed')
    expect(state.policy.authenticated).toMatchObject({
      select: 'all',
      insert: 'all',
      update: 'all',
    })
  })

  it('replaces only managed permissions in one metadata bulk request', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockResolvedValueOnce(tableMetadata({
        select_permissions: [
          {
            role: roles.authenticated,
            permission: { columns, filter: {}, allow_aggregations: false },
          },
          { role: 'user', permission: { columns: '*', filter: {} } },
        ],
      }) as never)
      .mockResolvedValueOnce({ message: 'success' } as never)

    const input: TableDataAccessInput = {
      authenticated: {
        select: 'owner',
        insert: 'owner',
        update: 'owner',
        delete: 'none',
        ownerColumn: 'owner_id',
      },
      anonymous: { select: true },
    }

    const state = await updateTableDataAccess(projectId, tableName, input)

    expect(tableService.trackTableInHasura).toHaveBeenCalledWith(schemaName, tableName)
    const bulkCall = vi.mocked(hasuraMetadataRequest).mock.calls.find(
      ([type]) => type === 'bulk_atomic'
    )
    expect(bulkCall).toBeDefined()
    const commands = bulkCall?.[1] as Array<{ type: string; args: { role: string } }>
    expect(commands.map((command) => command.type)).toEqual([
      'pg_drop_select_permission',
      'pg_create_select_permission',
      'pg_create_insert_permission',
      'pg_create_update_permission',
      'pg_create_select_permission',
    ])
    expect(commands.filter((command) => command.args.role === roles.anonymous))
      .toEqual([expect.objectContaining({ type: 'pg_create_select_permission' })])
    expect(commands.some((command) => command.args.role === 'user')).toBe(false)
    expect(state.policy).toEqual(input)
  })

  it('excludes generated columns from Hasura writes while keeping them readable', async () => {
    const readableColumns = [...columns, 'observed_at']
    vi.mocked(tableService.getTableMetadata).mockResolvedValueOnce({
      schemaName,
      tableName,
      columns: readableColumns.map((name) => ({
        name,
        type: 'text',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: name === 'id',
        isGenerated: name === 'observed_at',
        isIdentity: false,
        identityGeneration: null,
      })),
      rowCount: 0,
      sizeBytes: 0,
    })
    vi.mocked(hasuraMetadataRequest)
      .mockResolvedValueOnce(tableMetadata() as never)
      .mockResolvedValueOnce({ message: 'success' } as never)

    await updateTableDataAccess(projectId, tableName, {
      authenticated: {
        select: 'all',
        insert: 'owner',
        update: 'all',
        delete: 'none',
        ownerColumn: 'owner_id',
      },
      anonymous: { select: false },
    })

    const bulkCall = vi.mocked(hasuraMetadataRequest).mock.calls.find(
      ([type]) => type === 'bulk_atomic'
    )
    const commands = bulkCall?.[1] as Array<{
      type: string
      args: { permission: { columns?: string[]; set?: Record<string, string> } }
    }>
    expect(commands.find((item) => item.type === 'pg_create_select_permission')
      ?.args.permission.columns).toEqual(readableColumns)
    expect(commands.find((item) => item.type === 'pg_create_insert_permission')
      ?.args.permission).toMatchObject({
        columns: ['id', 'title'],
        set: { owner_id: 'X-Hasura-User-Id' },
      })
    expect(commands.find((item) => item.type === 'pg_create_update_permission')
      ?.args.permission.columns).toEqual(columns)
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

    await expect(
      updateTableDataAccess(projectId, tableName, closedPolicy())
    ).rejects.toBeInstanceOf(DataAccessConflictError)
    expect(tableService.trackTableInHasura).not.toHaveBeenCalled()
    expect(vi.mocked(hasuraMetadataRequest).mock.calls.some(
      ([type]) => type === 'bulk_atomic'
    )).toBe(false)
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

  it('does not write policy metadata when table tracking fails', async () => {
    vi.mocked(tableService.trackTableInHasura).mockResolvedValueOnce(false)

    await expect(
      updateTableDataAccess(projectId, tableName, closedPolicy())
    ).rejects.toBeInstanceOf(DataAccessUpstreamError)
    expect(vi.mocked(hasuraMetadataRequest).mock.calls.some(
      ([type]) => type === 'bulk_atomic'
    )).toBe(false)
  })

  it('normalizes metadata write failures as upstream errors', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockResolvedValueOnce(tableMetadata() as never)
      .mockRejectedValueOnce(new Error(
        'Hasura metadata request failed: {"error":"Column \\"observed_at\\" is not insertable","code":"permission-error","path":"$.args"}'
      ))

    const error = await updateTableDataAccess(projectId, tableName, {
        ...closedPolicy(),
        anonymous: { select: true },
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DataAccessUpstreamError)
    expect(error).toMatchObject({
      operation: 'update_permissions',
      projectId,
      schemaName,
      tableName,
      upstreamCode: 'permission-error',
      upstreamMessage: 'Column "observed_at" is not insertable',
    })
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
