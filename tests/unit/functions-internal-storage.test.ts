import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/storage/storage.service.js', () => ({
  getBucketByName: vi.fn(),
  uploadObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
}))

import * as storageService from '../../apps/api/src/modules/storage/storage.service.js'
import { internalFunctionsStorageRoutes } from '../../apps/api/src/modules/functions/internal-storage.routes.js'
import { signInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'

describe('Functions Internal Storage Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows uploads with a valid internal token and binds project scope from the token only', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    vi.mocked(storageService.getBucketByName).mockResolvedValue({
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
    })
    vi.mocked(storageService.uploadObject).mockResolvedValue({
      id: 1,
      objectId: 'obj_123',
      bucketId: 'bucket_123',
      name: 'avatars/a.png',
      size: 4,
      mimeType: 'image/png',
      etag: 'etag-1',
      storageProvider: 'local',
      storagePath: 'proj_123/team-assets/avatars/a.png',
      metadata: {},
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    vi.mocked(storageService.getDownloadUrl).mockResolvedValue({
      url: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/avatars/a.png',
      expiresIn: null,
    })

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'project_user',
      role: 'authenticated',
      projectUserId: 'pu_real',
      provider: 'wechat',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          projectId: 'proj_other',
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('file').toString('base64'),
          callerContext: {
            authType: 'project_user',
            projectId: 'proj_123',
            role: 'authenticated',
            projectUserId: 'pu_forged',
            provider: 'wechat',
          },
        },
      })

      expect(response.statusCode).toBe(200)
      expect(storageService.getBucketByName).toHaveBeenCalledWith('proj_123', 'team-assets')
      expect(storageService.uploadObject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj_123',
          name: 'team-assets',
        }),
        'avatars/a.png',
        expect.any(Buffer),
        'image/png',
        {
          createdByType: 'project_user',
          projectUserId: 'pu_real',
          sourceFunction: 'upload-avatar',
        }
      )

      expect(response.json()).toEqual({
        success: true,
        data: {
          path: 'avatars/a.png',
          publicUrl: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/avatars/a.png',
          object: expect.objectContaining({
            objectId: 'obj_123',
            name: 'avatars/a.png',
          }),
        },
      })
    } finally {
      await app.close()
    }
  })

  it('rejects requests with an invalid internal token', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        headers: {
          'x-druvia-internal-token': 'invalid-token',
        },
        payload: {
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('file').toString('base64'),
        },
      })

      expect(response.statusCode).toBe(401)
      expect(storageService.getBucketByName).not.toHaveBeenCalled()
      expect(storageService.uploadObject).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects uploads with invalid object paths', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'project_user',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          bucket: 'team-assets',
          path: '../avatars/a.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('file').toString('base64'),
        },
      })

      expect(response.statusCode).toBe(400)
      expect(storageService.getBucketByName).not.toHaveBeenCalled()
      expect(storageService.uploadObject).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects uploads with invalid base64 payloads', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'project_user',
      role: 'authenticated',
      projectUserId: 'pu_123',
      provider: 'wechat',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: '***not-base64***',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(storageService.getBucketByName).not.toHaveBeenCalled()
      expect(storageService.uploadObject).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects uploads when the bucket is not found in the token-bound project', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    vi.mocked(storageService.getBucketByName).mockResolvedValue(null)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'apikey',
      role: 'anon',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/upload',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('file').toString('base64'),
        },
      })

      expect(response.statusCode).toBe(404)
      expect(storageService.getBucketByName).toHaveBeenCalledWith('proj_123', 'team-assets')
      expect(storageService.uploadObject).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('removes an object with a valid internal token and token-bound project scope', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    vi.mocked(storageService.getBucketByName).mockResolvedValue({
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
    })
    vi.mocked(storageService.deleteObject).mockResolvedValue(true)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'project_user',
      role: 'authenticated',
      projectUserId: 'pu_123',
      provider: 'wechat',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/remove',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          projectId: 'proj_other',
          bucket: 'team-assets',
          path: 'avatars/old.png',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(storageService.getBucketByName).toHaveBeenCalledWith('proj_123', 'team-assets')
      expect(storageService.deleteObject).toHaveBeenCalledWith('bucket_123', 'avatars/old.png')
      expect(response.json()).toEqual({
        success: true,
        data: {
          path: 'avatars/old.png',
          deleted: true,
        },
      })
    } finally {
      await app.close()
    }
  })

  it('can ignore missing objects on internal remove when requested', async () => {
    const app = Fastify()
    await app.register(internalFunctionsStorageRoutes, { prefix: '/api' })

    vi.mocked(storageService.getBucketByName).mockResolvedValue({
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
    })
    vi.mocked(storageService.deleteObject).mockResolvedValue(false)

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      authType: 'project_user',
      role: 'authenticated',
      projectUserId: 'pu_123',
      provider: 'wechat',
      expiresIn: 120,
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/storage/remove',
        headers: {
          'x-druvia-internal-token': token,
        },
        payload: {
          bucket: 'team-assets',
          path: 'avatars/missing.png',
          ignoreMissing: true,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        success: true,
        data: {
          path: 'avatars/missing.png',
          deleted: false,
        },
      })
    } finally {
      await app.close()
    }
  })
})
