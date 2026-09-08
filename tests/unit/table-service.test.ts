import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequest: vi.fn(),
  hasuraMetadataRequestWithOptions: vi.fn(),
}))

import { pool, query, queryOne } from '../../apps/api/src/db/index.js'
import {
  hasuraMetadataRequest,
  hasuraMetadataRequestWithOptions,
} from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  addColumn,
  dropColumn,
  dropTable,
  getTableMetadata,
  getHasuraStatus,
  renameColumn,
  reloadHasuraMetadata,
  trackTableInHasura,
} from '../../apps/api/src/modules/table/table.service.js'

describe('Table Service Hasura Reload', () => {
  function tableMetadata(tracked = true) {
    return {
      resource_version: 10,
      metadata: {
        sources: [{
          name: 'default',
          tables: tracked ? [{ table: { schema: 'dru_test', name: 'orders' } }] : [],
        }],
      },
    }
  }

  function deletionClient() {
    const now = new Date('2026-09-07T00:00:00Z')
    return {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO druvia_table_deletion_outbox')) {
          return {
            rows: [{
              operation_id: 'td_existing',
              lock_scope: 'proj_123',
              schema_name: 'dru_test',
              table_name: 'orders',
              status: 'pending',
              attempts: 0,
              last_error: null,
              created_at: now,
              updated_at: now,
            }],
          }
        }
        return { rows: [], values }
      }),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never)
    vi.mocked(hasuraMetadataRequest).mockResolvedValue({ message: 'success' } as never)
    vi.mocked(hasuraMetadataRequestWithOptions).mockImplementation(async (type) => (
      type === 'export_metadata' ? tableMetadata() : { message: 'success' }
    ) as never)
  })

  it('reloads hasura metadata after adding a column', async () => {
    await addColumn('dru_test', 'users', {
      name: 'avatar_url',
      type: 'text',
      nullable: true,
    })

    expect(pool.query).toHaveBeenCalledWith(
      'ALTER TABLE "dru_test"."users" ADD COLUMN "avatar_url" text',
    )
    expect(hasuraMetadataRequest).toHaveBeenCalledWith(
      'reload_metadata',
      expect.objectContaining({
        reload_sources: true,
      })
    )
  })

  it('reloads hasura metadata after dropping a column', async () => {
    await dropColumn('dru_test', 'users', 'avatar_url')

    expect(pool.query).toHaveBeenCalledWith(
      'ALTER TABLE "dru_test"."users" DROP COLUMN "avatar_url"',
    )
    expect(hasuraMetadataRequest).toHaveBeenCalledWith(
      'reload_metadata',
      expect.objectContaining({
        reload_sources: true,
      })
    )
  })

  it('commits table deletion and its provenance cleanup on the same client', async () => {
    const client = deletionClient()
    const afterDrop = vi.fn(async (transactionClient: typeof client) => {
      await transactionClient.query(
        'DELETE FROM druvia_data_access_managed_policies WHERE project_id = $1',
        ['proj_123']
      )
    })

    await dropTable('dru_test', 'orders', {
      client: client as never,
      afterDrop,
      deletion: { operationId: 'td_new', lockScope: 'proj_123' },
    })

    expect(afterDrop).toHaveBeenCalledOnce()
    const statements = client.query.mock.calls.map(([sql]) => sql)
    expect(statements.slice(0, 4)).toEqual([
      'BEGIN',
      'DROP TABLE IF EXISTS "dru_test"."orders" CASCADE',
      'DELETE FROM "dru_test"._meta_tables WHERE table_name = $1',
      'DELETE FROM druvia_data_access_managed_policies WHERE project_id = $1',
    ])
    expect(statements[4]).toContain('INSERT INTO druvia_table_deletion_outbox')
    expect(statements[5]).toBe('COMMIT')
    expect(statements[6]).toContain('to_regclass')
    expect(statements[7]).toContain('DELETE FROM druvia_table_deletion_outbox')
    expect(pool.connect).not.toHaveBeenCalled()
    expect(client.query.mock.invocationCallOrder[5]).toBeLessThan(
      vi.mocked(hasuraMetadataRequestWithOptions).mock.invocationCallOrder.at(-1)!
    )
  })

  it('does not untrack Hasura when the table transaction rolls back', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('drop failed'))
        .mockResolvedValueOnce({ rows: [] }),
    }

    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .rejects.toThrow('drop failed')

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'DROP TABLE IF EXISTS "dru_test"."orders" CASCADE',
      'ROLLBACK',
    ])
    expect(hasuraMetadataRequest).not.toHaveBeenCalled()
    expect(hasuraMetadataRequestWithOptions).not.toHaveBeenCalled()
  })

  it('reports an untrack failure and converges when table deletion is retried', async () => {
    const client = deletionClient()
    let untrackAttempts = 0
    vi.mocked(hasuraMetadataRequestWithOptions).mockImplementation(async (type) => {
      if (type === 'export_metadata') return tableMetadata() as never
      if (type === 'pg_untrack_table' && untrackAttempts++ === 0) {
        throw new Error('metadata unavailable')
      }
      return { message: 'success' } as never
    })

    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .rejects.toThrow('metadata unavailable')
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("last_error = 'TABLE_UNTRACK_FAILED'")
    )).toBe(true)
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith('DELETE FROM druvia_table_deletion_outbox')
    )).toBe(false)
    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .resolves.toBeUndefined()

    expect(vi.mocked(hasuraMetadataRequestWithOptions).mock.calls.filter(
      ([type]) => type === 'pg_untrack_table'
    )).toHaveLength(2)
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith('DELETE FROM druvia_table_deletion_outbox')
    )).toBe(true)
  })

  it('clears the outbox when untrack succeeded but its response was lost', async () => {
    const client = deletionClient()
    let exports = 0
    vi.mocked(hasuraMetadataRequestWithOptions).mockImplementation(async (type) => {
      if (type === 'export_metadata') return tableMetadata(exports++ === 0) as never
      throw new Error('Hasura response was lost after apply')
    })

    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .resolves.toBeUndefined()
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith('DELETE FROM druvia_table_deletion_outbox')
    )).toBe(true)
  })

  it('keeps the deletion pending when the Hasura source is unavailable', async () => {
    const client = deletionClient()
    vi.mocked(hasuraMetadataRequestWithOptions).mockResolvedValueOnce({
      resource_version: 10,
      metadata: { sources: [] },
    } as never)

    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .rejects.toThrow('Default Hasura source is unavailable')
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith('DELETE FROM druvia_table_deletion_outbox')
    )).toBe(false)
    expect(vi.mocked(hasuraMetadataRequestWithOptions).mock.calls.some(
      ([type]) => type === 'pg_untrack_table'
    )).toBe(false)
  })

  it('keeps the deletion pending when the same PostgreSQL table was recreated', async () => {
    const client = deletionClient()
    client.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO druvia_table_deletion_outbox')) {
        return {
          rows: [{
            operation_id: 'td_existing', lock_scope: 'proj_123',
            schema_name: 'dru_test', table_name: 'orders', status: 'pending',
            attempts: 0, last_error: null,
            created_at: new Date('2026-09-07T00:00:00Z'),
            updated_at: new Date('2026-09-07T00:00:00Z'),
          }],
        }
      }
      if (sql.includes('to_regclass')) return { rows: [{ exists: true }] }
      return { rows: [], values }
    })

    await expect(dropTable('dru_test', 'orders', { client: client as never }))
      .rejects.toThrow('same name exists')

    expect(vi.mocked(hasuraMetadataRequestWithOptions)).not.toHaveBeenCalled()
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith('DELETE FROM druvia_table_deletion_outbox')
    )).toBe(false)
  })

  it('reloads hasura metadata after renaming a column', async () => {
    await renameColumn('dru_test', 'users', 'avatar_url', 'profile_image')

    expect(pool.query).toHaveBeenCalledWith(
      'ALTER TABLE "dru_test"."users" RENAME COLUMN "avatar_url" TO "profile_image"'
    )
    expect(hasuraMetadataRequest).toHaveBeenCalledWith(
      'reload_metadata',
      expect.objectContaining({
        reload_sources: true,
      })
    )
  })

  it('can manually reload hasura metadata', async () => {
    await reloadHasuraMetadata()

    expect(hasuraMetadataRequest).toHaveBeenCalledWith(
      'reload_metadata',
      expect.objectContaining({
        reload_sources: true,
      })
    )
  })

  it('tracks a table without creating default data permissions', async () => {
    const tracked = await trackTableInHasura('dru_test', 'orders')

    expect(tracked).toBe(true)
    expect(hasuraMetadataRequest).toHaveBeenCalledWith('pg_track_table', {
      source: 'default',
      table: { schema: 'dru_test', name: 'orders' },
    })
    expect(vi.mocked(hasuraMetadataRequest).mock.calls.some(([type]) =>
      String(type).includes('_permission')
    )).toBe(false)
  })

  it('reports a metadata tracking failure instead of returning success', async () => {
    vi.mocked(hasuraMetadataRequest).mockRejectedValueOnce(new Error('metadata unavailable'))

    const tracked = await trackTableInHasura('dru_test', 'orders')

    expect(tracked).toBe(false)
  })

  it('returns generated and identity capabilities with table columns', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([
        {
          column_name: 'id',
          data_type: 'bigint',
          is_nullable: 'NO',
          column_default: null,
          is_generated: 'NEVER',
          is_identity: 'YES',
          identity_generation: 'ALWAYS',
        },
        {
          column_name: 'observed_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
          is_generated: 'ALWAYS',
          is_identity: 'NO',
          identity_generation: null,
        },
      ] as never)
      .mockResolvedValueOnce([{ column_name: 'id' }] as never)
    vi.mocked(queryOne).mockResolvedValueOnce({ row_count: '1', size_bytes: '8192' })

    const result = await getTableMetadata('dru_test', 'observations')

    expect(result?.columns).toEqual([
      expect.objectContaining({
        name: 'id',
        isGenerated: false,
        isIdentity: true,
        identityGeneration: 'ALWAYS',
      }),
      expect.objectContaining({
        name: 'observed_at',
        isGenerated: true,
        isIdentity: false,
        identityGeneration: null,
      }),
    ])
    expect(String(vi.mocked(query).mock.calls[0][0])).toContain('is_generated')
    expect(String(vi.mocked(query).mock.calls[0][0])).toContain('identity_generation')
  })

  it('treats an already tracked table as success', async () => {
    vi.mocked(hasuraMetadataRequest).mockRejectedValueOnce(new Error('table already tracked'))

    const tracked = await trackTableInHasura('dru_test', 'orders')

    expect(tracked).toBe(true)
  })

  it('reports application-facing read access for tracked tables', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_test', name: 'orders' },
          select_permissions: [{ role: 'user' }, { role: 'anonymous' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_test')

    expect(status.orders).toEqual({
      tracked: true,
      runtimeAvailability: 'available',
      hasAuthenticatedRead: true,
      hasAnonymousRead: true,
    })
  })

  it('recognizes expected scoped roles without exposing them as UI policy', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_test', name: 'orders' },
          select_permissions: [{ role: 'scoped_user' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_test', {
      authenticated: 'scoped_user',
      anonymous: 'scoped_anon',
    })

    expect(status.orders.hasAuthenticatedRead).toBe(true)
    expect(status.orders.hasAnonymousRead).toBe(false)
    expect(status.orders).not.toHaveProperty('selectRoles')
  })

  it('does not accept legacy roles when explicit scoped roles are expected', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_test', name: 'orders' },
          select_permissions: [{ role: 'user' }, { role: 'anonymous' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_test', {
      authenticated: 'scoped_user',
      anonymous: 'scoped_anon',
    })

    expect(status.orders.hasAuthenticatedRead).toBe(false)
    expect(status.orders.hasAnonymousRead).toBe(false)
  })

  it('does not accept scoped roles when compatibility roles are expected', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_test', name: 'orders' },
          select_permissions: [{ role: 'scoped_user' }, { role: 'scoped_anon' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_test')

    expect(status.orders.hasAuthenticatedRead).toBe(false)
    expect(status.orders.hasAnonymousRead).toBe(false)
  })

  it('reports environment runtime access as unavailable without checking roles', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_preview', name: 'orders' },
          select_permissions: [{ role: 'user' }, { role: 'scoped_user' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_preview', undefined, 'environment_identity_required')

    expect(status.orders).toEqual({
      tracked: true,
      runtimeAvailability: 'environment_identity_required',
      hasAuthenticatedRead: false,
      hasAnonymousRead: false,
    })
  })

  it('reads table status from the default Hasura source', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [
        {
          name: 'analytics',
          tables: [{
            table: { schema: 'dru_test', name: 'orders' },
            select_permissions: [{ role: 'anonymous' }],
          }],
        },
        {
          name: 'default',
          tables: [{
            table: { schema: 'dru_test', name: 'orders' },
            select_permissions: [{ role: 'user' }],
          }],
        },
      ],
    } as never)

    const status = await getHasuraStatus('dru_test')

    expect(status.orders.hasAuthenticatedRead).toBe(true)
    expect(status.orders.hasAnonymousRead).toBe(false)
  })
})
