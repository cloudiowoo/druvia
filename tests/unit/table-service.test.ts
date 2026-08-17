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

import { pool } from '../../apps/api/src/db/index.js'
import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import {
  addColumn,
  dropColumn,
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

  it('treats an already tracked table as success', async () => {
    vi.mocked(hasuraMetadataRequest).mockRejectedValueOnce(new Error('table already tracked'))

    const tracked = await trackTableInHasura('dru_test', 'orders')

    expect(tracked).toBe(true)
  })

  it('reports application-facing read access for tracked tables', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
        tables: [{
          table: { schema: 'dru_test', name: 'orders' },
          select_permissions: [{ role: 'user' }, { role: 'anonymous' }],
        }],
      }],
    } as never)

    const status = await getHasuraStatus('dru_test')

    expect(status.orders).toEqual({
      tracked: true,
      selectRoles: ['user', 'anonymous'],
      hasAuthenticatedRead: true,
      hasAnonymousRead: true,
    })
  })

  it('recognizes expected scoped roles without exposing them as UI policy', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce({
      sources: [{
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
  })
})
