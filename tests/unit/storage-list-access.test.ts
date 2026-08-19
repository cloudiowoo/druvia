import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: { connect: vi.fn() },
}))

vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({
  getDefaultStorageAdapter: vi.fn(),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js'

const bucket: storageService.Bucket = {
  id: 1,
  bucketId: 'bucket_123',
  projectId: 'proj_123',
  name: 'private-files',
  public: false,
  projectUserAccess: 'owner_only',
  fileSizeLimit: null,
  allowedMimeTypes: null,
  corsConfig: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const actor = {
  actorType: 'project_user' as const,
  projectId: 'proj_123',
  projectUserId: 'puser_1',
}

const bucketRow = {
  id: 1,
  bucket_id: bucket.bucketId,
  project_id: bucket.projectId,
  name: bucket.name,
  public: bucket.public,
  project_user_access: bucket.projectUserAccess,
  file_size_limit: null,
  allowed_mime_types: null,
  cors_config: null,
  created_at: new Date(),
  updated_at: new Date(),
}

describe('Storage actor list boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unbounded pagination before querying storage metadata', async () => {
    await expect(storageService.listObjectsForActor(bucket, actor, { limit: 0 }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(queryOne).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a cross-project actor before querying object metadata', async () => {
    await expect(storageService.listObjectsForActor(
      bucket,
      { ...actor, projectId: 'proj_other' },
      { limit: 25 }
    )).rejects.toMatchObject({ code: 'PROJECT_SCOPE_MISMATCH', statusCode: 403 })
    expect(queryOne).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('applies the same owner and literal-prefix predicate to count and rows', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(bucketRow as never)
      .mockResolvedValueOnce({ count: '1' } as never)
    vi.mocked(query).mockResolvedValue([{
      id: 1,
      object_id: 'obj_1',
      bucket_id: bucket.bucketId,
      name: 'avatars/one.png',
      size: 3,
      mime_type: 'image/png',
      etag: null,
      storage_provider: 'local',
      storage_path: 'proj_123/bucket_123/objects/obj_1',
      metadata: {},
      created_by: null,
      owner_project_user_id: actor.projectUserId,
      created_at: new Date(),
      updated_at: new Date(),
    }] as never)

    const result = await storageService.listObjectsForActor(
      bucket,
      actor,
      { prefix: 'avatars/%_', limit: 25, offset: 0 }
    )

    expect(result.total).toBe(1)
    expect(vi.mocked(queryOne).mock.calls[1]?.[0]).toContain('owner_project_user_id')
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('owner_project_user_id')
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]).toEqual([
      bucket.bucketId,
      'avatars/\\%\\_%',
      actor.projectUserId,
    ])
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([
      bucket.bucketId,
      'avatars/\\%\\_%',
      actor.projectUserId,
      25,
    ])
  })
})
