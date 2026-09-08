import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequest: vi.fn(),
  hasuraMetadataRequestWithOptions: vi.fn(),
}))

import {
  hasuraMetadataRequest,
  hasuraMetadataRequestWithOptions,
} from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  applyHasuraMetadataCommands,
  buildMetadataWithTablePermissions,
  HasuraMetadataMutationUncertainError,
  replaceHasuraTablePermissions,
} from '../../apps/api/src/modules/data-access/hasura-metadata-bulk.js'

const commands = [{
  type: 'pg_create_select_permission',
  args: { source: 'default', role: 'project_user' },
}]

describe('Hasura metadata permission batches', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the atomic API when the running Hasura supports the command', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce([] as never)

    await applyHasuraMetadataCommands(commands)

    expect(hasuraMetadataRequest).toHaveBeenCalledOnce()
    expect(hasuraMetadataRequest).toHaveBeenCalledWith('bulk_atomic', commands)
  })

  it('falls back only for the exact unsupported atomic-command response', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: Bulk atomic does not support this command'))
      .mockResolvedValueOnce([] as never)

    await applyHasuraMetadataCommands(commands)

    expect(hasuraMetadataRequest).toHaveBeenNthCalledWith(1, 'bulk_atomic', commands)
    expect(hasuraMetadataRequest).toHaveBeenNthCalledWith(2, 'bulk', commands)
  })

  it('requires a fresh writer fence before sending the non-atomic fallback', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: Bulk atomic does not support this command'))
    const leaseError = new Error('writer lease expired')
    const beforeFallback = vi.fn().mockRejectedValueOnce(leaseError)

    await expect(applyHasuraMetadataCommands(commands, { beforeFallback }))
      .rejects.toBe(leaseError)

    expect(beforeFallback).toHaveBeenCalledOnce()
    expect(hasuraMetadataRequest).toHaveBeenCalledOnce()
  })

  it('marks a failed non-atomic fallback as an unknown write outcome', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: Bulk atomic does not support this command'))
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: later command failed'))

    await expect(applyHasuraMetadataCommands(commands))
      .rejects.toBeInstanceOf(HasuraMetadataMutationUncertainError)
  })

  it('does not retry validation or transport failures through a weaker mode', async () => {
    vi.mocked(hasuraMetadataRequest).mockRejectedValueOnce(new Error('permission validation failed'))

    await expect(applyHasuraMetadataCommands(commands)).rejects.toThrow('permission validation failed')
    expect(hasuraMetadataRequest).toHaveBeenCalledOnce()
  })

  it('preserves the same resource-version fence for atomic fallback', async () => {
    vi.mocked(hasuraMetadataRequestWithOptions)
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: Bulk atomic does not support this command'))
      .mockResolvedValueOnce([] as never)

    await applyHasuraMetadataCommands(commands, { resourceVersion: 801n, timeoutMs: 30_000 })

    expect(hasuraMetadataRequestWithOptions).toHaveBeenNthCalledWith(
      1, 'bulk_atomic', commands, { resourceVersion: 801n, timeoutMs: 30_000 }
    )
    expect(hasuraMetadataRequestWithOptions).toHaveBeenNthCalledWith(
      2, 'bulk', commands, { resourceVersion: 801n, timeoutMs: 30_000 }
    )
    expect(hasuraMetadataRequest).not.toHaveBeenCalled()
  })

  it('replaces only scoped permissions on the requested table', () => {
    const metadata = {
      version: 3,
      sources: [{
        name: 'default',
        tables: [
          {
            table: { schema: 'app', name: 'sessions' },
            object_relationships: [{ name: 'owner', using: {} }],
            select_permissions: [
              { role: 'scope_user', permission: { columns: ['retired'], filter: {} } },
              { role: 'user', permission: { columns: '*', filter: {} } },
            ],
          },
          {
            table: { schema: 'app', name: 'other' },
            select_permissions: [{ role: 'scope_user', permission: { columns: ['id'], filter: {} } }],
          },
        ],
      }],
    }

    const replaced = buildMetadataWithTablePermissions(metadata, {
      sourceName: 'default',
      schemaName: 'app',
      tableName: 'sessions',
      scopedRoles: ['scope_user', 'scope_anon'],
      permissions: [
        { role: 'scope_user', operation: 'select', permission: { columns: ['id'], filter: {} } },
        { role: 'scope_anon', operation: 'select', permission: { columns: ['id'], filter: {} } },
      ],
    })

    expect(replaced).not.toBe(metadata)
    expect(replaced.sources?.[0].tables?.[0]).toEqual({
      table: { schema: 'app', name: 'sessions' },
      object_relationships: [{ name: 'owner', using: {} }],
      select_permissions: [
        { role: 'user', permission: { columns: '*', filter: {} } },
        { role: 'scope_anon', permission: { columns: ['id'], filter: {} } },
        { role: 'scope_user', permission: { columns: ['id'], filter: {} } },
      ],
    })
    expect(replaced.sources?.[0].tables?.[1]).toEqual(metadata.sources[0].tables[1])
    expect(metadata.sources[0].tables[0].select_permissions[0].permission.columns)
      .toEqual(['retired'])
  })

  it('applies a table-scoped replacement with the resource-version fence', async () => {
    vi.mocked(hasuraMetadataRequestWithOptions).mockResolvedValueOnce({ message: 'success' } as never)
    const metadata = {
      version: 3,
      sources: [{ name: 'default', tables: [{ table: { schema: 'app', name: 'sessions' } }] }],
    }

    await replaceHasuraTablePermissions(metadata, {
      sourceName: 'default',
      schemaName: 'app',
      tableName: 'sessions',
      scopedRoles: ['scope_user', 'scope_anon'],
      permissions: [],
      resourceVersion: 802n,
      allowInconsistentMetadata: false,
    })

    expect(hasuraMetadataRequestWithOptions).toHaveBeenCalledWith(
      'replace_metadata',
      {
        allow_inconsistent_metadata: false,
        metadata,
      },
      { resourceVersion: 802n, timeoutMs: 30_000 }
    )
  })
})
