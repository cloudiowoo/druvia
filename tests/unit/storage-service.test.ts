import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: {
    connect: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({
  getDefaultStorageAdapter: vi.fn(),
}))

import { pool } from '../../apps/api/src/db/index.js'
import { getDefaultStorageAdapter } from '../../apps/api/src/adapters/storage/index.js'
import { uploadObject, type Bucket } from '../../apps/api/src/modules/storage/storage.service.js'

const mockConnect = vi.mocked(pool.connect)
const mockGetDefaultStorageAdapter = vi.mocked(getDefaultStorageAdapter)

describe('Storage Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists audit metadata and refresh fields in the upsert query', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            object_id: 'obj_123',
            bucket_id: 'bucket_123',
            name: 'avatars/a.png',
            size: 4,
            mime_type: 'image/png',
            etag: 'etag-1',
            storage_provider: 'local',
            storage_path: 'proj_123/team-assets/avatars/a.png',
            metadata: {
              created_by_type: 'project_user',
              created_by_project_user_id: 'pu_123',
              source_function: 'upload-avatar',
            },
            created_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })
        .mockResolvedValueOnce(undefined),
      release: vi.fn(),
    }
    mockConnect.mockResolvedValue(client as never)
    mockGetDefaultStorageAdapter.mockReturnValue({
      name: 'local',
      upload: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
      download: vi.fn(),
      delete: vi.fn(),
      getSignedUrl: vi.fn(),
      getPublicUrl: vi.fn(),
    } as never)

    const bucket: Bucket = {
      id: 1,
      bucketId: 'bucket_123',
      projectId: 'proj_123',
      name: 'team-assets',
      public: true,
      fileSizeLimit: null,
      allowedMimeTypes: null,
      corsConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    await uploadObject(
      bucket,
      'avatars/a.png',
      Buffer.from('file'),
      'image/png',
      {
        createdByType: 'project_user',
        projectUserId: 'pu_123',
        sourceFunction: 'upload-avatar',
      }
    )

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('metadata = $9::jsonb'),
      [
        expect.any(String),
        'bucket_123',
        'avatars/a.png',
        4,
        'image/png',
        'etag-1',
        'local',
        'proj_123/team-assets/avatars/a.png',
        JSON.stringify({
          created_by_type: 'project_user',
          created_by_project_user_id: 'pu_123',
          source_function: 'upload-avatar',
        }),
        null,
      ]
    )
    expect(client.query).toHaveBeenNthCalledWith(3, 'COMMIT')
  })
})
