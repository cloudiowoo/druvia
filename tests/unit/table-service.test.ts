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
}))

import { pool, query, queryOne } from '../../apps/api/src/db/index.js'
import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  addColumn,
  dropColumn,
  getTableMetadata,
  getHasuraStatus,
  renameColumn,
  reloadHasuraMetadata,
  trackTableInHasura,
} from '../../apps/api/src/modules/table/table.service.js'

describe('Table Service Hasura Reload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never)
    vi.mocked(hasuraMetadataRequest).mockResolvedValue({ message: 'success' } as never)
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
