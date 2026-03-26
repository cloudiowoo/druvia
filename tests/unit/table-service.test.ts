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
  renameColumn,
  reloadHasuraMetadata,
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
})
