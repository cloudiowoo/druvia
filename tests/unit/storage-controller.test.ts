import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  pool: { connect: vi.fn() },
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/storage/storage.service.js', () => ({
  deleteObject: vi.fn(),
  getBucketByName: vi.fn(),
  getDownloadUrl: vi.fn(),
  getObjectForActor: vi.fn(),
  listObjects: vi.fn(),
}))

import * as storageService from '../../apps/api/src/modules/storage/storage.service.js'
import {
  deleteObject,
  downloadObject,
  getSignedUrl,
  listObjects,
  uploadObject,
} from '../../apps/api/src/modules/storage/storage.controller.js'

function replyStub() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn((statusCode: number) => {
      reply.statusCode = statusCode
      return reply
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload
      return payload
    }),
  }
  return reply
}

describe('Storage object controller actor boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a Project User credential scoped to another project', async () => {
    const reply = replyStub()
    await listObjects({
      user: {
        kind: 'project_user',
        sub: 'project-user-1',
        projectId: 'project-other',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      },
      params: { projectId: 'project-target', bucketName: 'avatars' },
      query: {},
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toMatchObject({
      error: { code: 'PROJECT_SCOPE_MISMATCH' },
    })
    expect(storageService.getBucketByName).not.toHaveBeenCalled()
  })

  it('rejects an API key before reading bucket state', async () => {
    const reply = replyStub()
    await listObjects({
      user: {
        kind: 'apikey',
        projectId: 'project-target',
        role: 'anon',
        apiKeyId: 1,
        apiKeyPrefix: 'dru_123',
      },
      params: { projectId: 'project-target', bucketName: 'avatars' },
      query: {},
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toMatchObject({
      error: { code: 'PROJECT_ACTOR_REQUIRED' },
    })
    expect(storageService.getBucketByName).not.toHaveBeenCalled()
  })

  it('rejects admin-only Project User uploads before buffering multipart data', async () => {
    vi.mocked(storageService.getBucketByName).mockResolvedValue({
      bucketId: 'bucket-1',
      projectId: 'project-target',
      name: 'avatars',
      public: false,
      projectUserAccess: 'admin_only',
    } as never)
    const file = vi.fn()
    const reply = replyStub()

    await uploadObject({
      user: {
        kind: 'project_user',
        sub: 'project-user-1',
        projectId: 'project-target',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      },
      params: { projectId: 'project-target', bucketName: 'avatars' },
      query: {},
      file,
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toMatchObject({ error: { code: 'STORAGE_ACCESS_DISABLED' } })
    expect(file).not.toHaveBeenCalled()
  })

  it('uses the non-disclosing object error code when a protected object is missing', async () => {
    vi.mocked(storageService.getBucketByName).mockResolvedValue({
      bucketId: 'bucket-1',
      projectId: 'project-target',
      name: 'avatars',
      public: false,
      projectUserAccess: 'owner_only',
    } as never)
    vi.mocked(storageService.getObjectForActor).mockResolvedValue(null)
    const reply = replyStub()

    await downloadObject({
      user: {
        kind: 'project_user',
        sub: 'project-user-1',
        projectId: 'project-target',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      },
      params: {
        projectId: 'project-target',
        bucketName: 'avatars',
        '*': 'missing.png',
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(404)
    expect(reply.payload).toMatchObject({ error: { code: 'OBJECT_NOT_FOUND' } })
  })

  it('uses the non-disclosing object error code when protected delete finds no object', async () => {
    vi.mocked(storageService.getBucketByName).mockResolvedValue({
      bucketId: 'bucket-1', projectId: 'project-target', name: 'avatars',
      public: false, projectUserAccess: 'owner_only',
    } as never)
    vi.mocked(storageService.deleteObject).mockResolvedValue(false)
    const reply = replyStub()

    await deleteObject({
      user: {
        kind: 'project_user', sub: 'project-user-1', projectId: 'project-target',
        authType: 'project_user', role: 'authenticated', provider: 'wechat',
      },
      params: { projectId: 'project-target', bucketName: 'avatars', '*': 'missing.png' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(404)
    expect(reply.payload).toMatchObject({ error: { code: 'OBJECT_NOT_FOUND' } })
  })

  it('uses the non-disclosing object error code when signed URL creation finds no object', async () => {
    vi.mocked(storageService.getBucketByName).mockResolvedValue({
      bucketId: 'bucket-1', projectId: 'project-target', name: 'avatars',
      public: false, projectUserAccess: 'owner_only',
    } as never)
    vi.mocked(storageService.getObjectForActor).mockResolvedValue(null)
    const reply = replyStub()

    await getSignedUrl({
      user: {
        kind: 'project_user', sub: 'project-user-1', projectId: 'project-target',
        authType: 'project_user', role: 'authenticated', provider: 'wechat',
      },
      params: { projectId: 'project-target', bucketName: 'avatars' },
      body: { objectPath: 'missing.png', expiresIn: 300 },
    } as never, reply as never)

    expect(reply.statusCode).toBe(404)
    expect(reply.payload).toMatchObject({ error: { code: 'OBJECT_NOT_FOUND' } })
    expect(storageService.getDownloadUrl).not.toHaveBeenCalled()
  })
})
