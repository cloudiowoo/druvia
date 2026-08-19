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
const mockStorage = {
  name: 'local',
  upload: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  getPublicUrl: vi.fn(),
}

const bucket: Bucket = {
  id: 1,
  bucketId: 'bucket_123',
  projectId: 'proj_123',
  name: 'team-assets',
  public: true,
  projectUserAccess: 'admin_only',
  fileSizeLimit: null,
  allowedMimeTypes: null,
  corsConfig: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const bucketRow = {
  id: 1,
  bucket_id: 'bucket_123',
  project_id: 'proj_123',
  name: 'team-assets',
  public: true,
  project_user_access: 'admin_only',
  file_size_limit: null,
  allowed_mime_types: null,
  cors_config: null,
  created_at: new Date(),
  updated_at: new Date(),
}

describe('Storage Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDefaultStorageAdapter.mockReturnValue(mockStorage as never)
    mockStorage.upload.mockResolvedValue({ etag: 'etag-1' })
    mockStorage.delete.mockResolvedValue(undefined)
  })

  it('persists audit metadata and refresh fields in the upsert query', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [{
            ...bucketRow,
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
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
            storage_path: expect.any(String),
            metadata: {
              created_by_type: 'project_user',
              created_by_project_user_id: 'pu_123',
              source_function: 'upload-avatar',
            },
            created_by: null,
            owner_project_user_id: 'pu_123',
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })
        .mockResolvedValueOnce(undefined),
      release: vi.fn(),
    }
    mockConnect.mockResolvedValue(client as never)

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
      'SELECT * FROM druvia_storage_buckets WHERE bucket_id = $1 FOR SHARE',
      ['bucket_123']
    )
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('pg_advisory_xact_lock'),
      ['10:bucket_123avatars/a.png']
    )
    expect(client.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('metadata = $9::jsonb'),
      [
        expect.any(String),
        'bucket_123',
        'avatars/a.png',
        4,
        'image/png',
        'etag-1',
        'local',
        expect.stringMatching(/^proj_123\/bucket_123\/objects\/obj_/),
        JSON.stringify({
          created_by_type: 'project_user',
          created_by_project_user_id: 'pu_123',
          source_function: 'upload-avatar',
        }),
        null,
        'pu_123',
      ]
    )
    expect(client.query).toHaveBeenNthCalledWith(6, 'COMMIT')
  })

  it('repairs an empty legacy storage path with the existing object id', async () => {
    const existingObject = {
      id: 2,
      object_id: 'obj_existing',
      bucket_id: bucket.bucketId,
      name: 'avatars/legacy.png',
      size: 3,
      mime_type: 'image/png',
      etag: null,
      storage_provider: 'local',
      storage_path: '',
      metadata: {},
      created_by: null,
      owner_project_user_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repairedPath = 'proj_123/bucket_123/objects/obj_existing'
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [bucketRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [existingObject] })
        .mockResolvedValueOnce({ rows: [{ ...existingObject, storage_path: repairedPath }] })
        .mockResolvedValueOnce(undefined),
      release: vi.fn(),
    }
    mockConnect.mockResolvedValue(client as never)

    const object = await uploadObject(bucket, existingObject.name, Buffer.from('new'), 'image/png')

    expect(mockStorage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      repairedPath,
      { contentType: 'image/png' }
    )
    expect(object.storagePath).toBe(repairedPath)
  })

  it('removes a generated repair key when database persistence fails', async () => {
    const existingObject = {
      id: 3,
      object_id: 'obj_null_path',
      bucket_id: bucket.bucketId,
      name: 'avatars/null-path.png',
      size: 3,
      mime_type: 'image/png',
      etag: null,
      storage_provider: 'local',
      storage_path: null,
      metadata: {},
      created_by: null,
      owner_project_user_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const repairedPath = 'proj_123/bucket_123/objects/obj_null_path'
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [bucketRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [existingObject] })
        .mockRejectedValueOnce(new Error('database write failed'))
        .mockResolvedValueOnce(undefined),
      release: vi.fn(),
    }
    mockConnect.mockResolvedValue(client as never)

    await expect(uploadObject(
      bucket,
      existingObject.name,
      Buffer.from('new'),
      'image/png'
    )).rejects.toThrow('database write failed')

    expect(mockStorage.delete).toHaveBeenCalledWith(repairedPath)
  })
})
