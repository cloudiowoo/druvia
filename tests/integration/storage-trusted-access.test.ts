import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js', () => ({
  TRUSTED_BACKEND_KEY_SCOPES: ['project_session:issue', 'storage_ticket:issue'],
  createTrustedBackendKey: vi.fn(),
  listTrustedBackendKeys: vi.fn(),
  deleteTrustedBackendKey: vi.fn(),
  validateTrustedBackendKey: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/storage/storage-trusted-access.service.js', () => ({
  StorageTrustedAccessError: class StorageTrustedAccessError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number
    ) {
      super(message)
    }
  },
  issueUploadTicket: vi.fn(),
  issueRemoveTicket: vi.fn(),
  verifyUploadTicket: vi.fn(),
  verifyRemoveTicket: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/storage/storage.service.js', () => ({
  listBuckets: vi.fn(),
  createBucket: vi.fn(),
  getBucketByName: vi.fn(),
  updateBucket: vi.fn(),
  deleteBucket: vi.fn(),
  listObjects: vi.fn(),
  uploadObject: vi.fn(),
  getObject: vi.fn(),
  downloadObject: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
}))

import { buildApp } from '../../apps/api/src/index.js'
import { validateTrustedBackendKey } from '../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js'
import {
  issueRemoveTicket,
  issueUploadTicket,
  StorageTrustedAccessError,
  verifyRemoveTicket,
  verifyUploadTicket,
} from '../../apps/api/src/modules/storage/storage-trusted-access.service.js'
import * as storageService from '../../apps/api/src/modules/storage/storage.service.js'

function createMultipartBody(filename: string, contentType: string, content: string, boundary = '----druvia-boundary') {
  const body =
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`
    + `${content}\r\n`
    + `--${boundary}--\r\n`

  return {
    boundary,
    payload: body,
  }
}

describe('storage trusted access routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('issues upload/remove tickets with a valid trusted backend key and rejects apikey fallback', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: true,
      projectId: 'proj_123',
      keyPrefix: 'drutb_123',
      scopes: ['storage_ticket:issue'],
    })
    vi.mocked(issueUploadTicket).mockResolvedValue({
      ticket: 'upload-ticket',
      expiresIn: 300,
      expiresAt: '2026-03-28T12:00:00.000Z',
      payload: {
        purpose: 'upload',
        projectId: 'proj_123',
        projectUserId: 'usr_proj_1',
        bucket: 'team-assets',
        pathPrefix: 'user-avatars/',
        issuedBy: 'drutb_123',
        issuedVia: 'trusted_storage_ticket',
      },
    })
    vi.mocked(issueRemoveTicket).mockResolvedValue({
      ticket: 'remove-ticket',
      expiresIn: 300,
      expiresAt: '2026-03-28T12:00:00.000Z',
      payload: {
        purpose: 'remove',
        projectId: 'proj_123',
        projectUserId: 'usr_proj_1',
        bucket: 'team-assets',
        path: 'user-avatars/avatar.png',
        issuedBy: 'drutb_123',
        issuedVia: 'trusted_storage_ticket',
      },
    })

    const app = buildApp()

    try {
      const uploadIssuer = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: {
          userId: 'usr_proj_1',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
        },
      })
      const removeIssuer = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/remove-ticket',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: {
          userId: 'usr_proj_1',
          bucket: 'team-assets',
          path: 'user-avatars/avatar.png',
        },
      })
      const apikeyOnly = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        headers: {
          apikey: 'dru_anon',
        },
        payload: {
          userId: 'usr_proj_1',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
        },
      })

      expect(uploadIssuer.statusCode).toBe(200)
      expect(removeIssuer.statusCode).toBe(200)
      expect(apikeyOnly.statusCode).toBe(401)
      expect(issueUploadTicket).toHaveBeenCalledWith({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'team-assets',
        pathPrefix: 'user-avatars/',
        contentTypes: undefined,
        maxBytes: undefined,
        expiresIn: undefined,
        issuedBy: 'drutb_123',
      })
      expect(issueRemoveTicket).toHaveBeenCalledWith({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'team-assets',
        path: 'user-avatars/avatar.png',
        expiresIn: undefined,
        issuedBy: 'drutb_123',
      })
    } finally {
      await app.close()
    }
  })

  it('rejects wrong-scope, wrong-project and unknown-user issuer requests', async () => {
    const app = buildApp()

    try {
      vi.mocked(validateTrustedBackendKey).mockResolvedValueOnce({
        valid: false,
        reason: 'scope_missing',
        projectId: 'proj_123',
        keyPrefix: 'drutb_123',
        scopes: ['project_session:issue'],
      })
      const wrongScope = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: {
          userId: 'usr_proj_1',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
        },
      })

      vi.mocked(validateTrustedBackendKey).mockResolvedValueOnce({
        valid: false,
        reason: 'project_mismatch',
        projectId: 'proj_other',
        keyPrefix: 'drutb_456',
        scopes: ['storage_ticket:issue'],
      })
      const wrongProject = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: {
          userId: 'usr_proj_1',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
        },
      })

      vi.mocked(validateTrustedBackendKey).mockResolvedValueOnce({
        valid: true,
        projectId: 'proj_123',
        keyPrefix: 'drutb_789',
        scopes: ['storage_ticket:issue'],
      })
      vi.mocked(issueUploadTicket).mockRejectedValueOnce(
        new StorageTrustedAccessError('USER_NOT_FOUND', 'Project user not found', 404)
      )
      const unknownUser = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/storage/trusted/upload-ticket',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: {
          userId: 'usr_missing',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
        },
      })

      expect(wrongScope.statusCode).toBe(403)
      expect(wrongProject.statusCode).toBe(403)
      expect(unknownUser.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('consumes upload/remove tickets and enforces prefix/path, mime and size constraints', async () => {
    vi.mocked(verifyUploadTicket).mockReturnValue({
      purpose: 'upload',
      projectId: 'proj_123',
      projectUserId: 'usr_proj_1',
      bucket: 'team-assets',
      pathPrefix: 'user-avatars/',
      contentTypes: ['image/png'],
      maxBytes: 8,
      issuedBy: 'drutb_123',
      issuedVia: 'trusted_storage_ticket',
    })
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
      name: 'user-avatars/avatar.png',
      size: 4,
      mimeType: 'image/png',
      etag: 'etag-123',
      storageProvider: 'local',
      storagePath: 'proj_123/team-assets/user-avatars/avatar.png',
      metadata: {},
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    vi.mocked(storageService.getDownloadUrl).mockResolvedValue({
      url: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/user-avatars/avatar.png',
      expiresIn: null,
    })
    vi.mocked(verifyRemoveTicket).mockReturnValue({
      purpose: 'remove',
      projectId: 'proj_123',
      projectUserId: 'usr_proj_1',
      bucket: 'team-assets',
      path: 'user-avatars/avatar.png',
      issuedBy: 'drutb_123',
      issuedVia: 'trusted_storage_ticket',
    })
    vi.mocked(storageService.deleteObject).mockResolvedValue(true)

    const app = buildApp()
    const uploadMultipart = createMultipartBody('avatar.png', 'image/png', 'file')
    const largeMultipart = createMultipartBody('avatar.png', 'image/png', 'file-is-large')
    const wrongMimeMultipart = createMultipartBody('avatar.jpg', 'image/jpeg', 'file')

    try {
      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket?path=user-avatars/avatar.png',
        headers: {
          'content-type': `multipart/form-data; boundary=${uploadMultipart.boundary}`,
          'x-druvia-storage-ticket': 'storage-ticket',
        },
        payload: uploadMultipart.payload,
      })
      const wrongPrefix = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket?path=team-logos/avatar.png',
        headers: {
          'content-type': `multipart/form-data; boundary=${uploadMultipart.boundary}`,
          'x-druvia-storage-ticket': 'storage-ticket',
        },
        payload: uploadMultipart.payload,
      })
      const invalidMime = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket?path=user-avatars/avatar.jpg',
        headers: {
          'content-type': `multipart/form-data; boundary=${wrongMimeMultipart.boundary}`,
          'x-druvia-storage-ticket': 'storage-ticket',
        },
        payload: wrongMimeMultipart.payload,
      })
      const tooLarge = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket?path=user-avatars/avatar.png',
        headers: {
          'content-type': `multipart/form-data; boundary=${largeMultipart.boundary}`,
          'x-druvia-storage-ticket': 'storage-ticket',
        },
        payload: largeMultipart.payload,
      })
      vi.mocked(verifyUploadTicket).mockImplementationOnce(() => {
        throw new StorageTrustedAccessError('INVALID_TICKET', 'Storage ticket expired', 401)
      })
      const expired = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/upload-with-ticket?path=user-avatars/avatar.png',
        headers: {
          'content-type': `multipart/form-data; boundary=${uploadMultipart.boundary}`,
          'x-druvia-storage-ticket': 'expired-ticket',
        },
        payload: uploadMultipart.payload,
      })
      const removeResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/remove-with-ticket',
        headers: {
          'x-druvia-storage-ticket': 'remove-ticket',
        },
        payload: { path: 'user-avatars/avatar.png' },
      })
      const removeWrongPath = await app.inject({
        method: 'POST',
        url: '/api/v1/storage/remove-with-ticket',
        headers: {
          'x-druvia-storage-ticket': 'remove-ticket',
        },
        payload: { path: 'team-logos/avatar.png' },
      })

      expect(uploadResponse.statusCode).toBe(201)
      expect(wrongPrefix.statusCode).toBe(403)
      expect(invalidMime.statusCode).toBe(415)
      expect(tooLarge.statusCode).toBe(413)
      expect(expired.statusCode).toBe(401)
      expect(removeResponse.statusCode).toBe(200)
      expect(removeWrongPath.statusCode).toBe(403)
      expect(storageService.uploadObject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj_123',
          name: 'team-assets',
        }),
        'user-avatars/avatar.png',
        expect.any(Buffer),
        'image/png',
        {
          createdByType: 'trusted_backend_project_user',
          projectUserId: 'usr_proj_1',
          issuedBy: 'drutb_123',
          issuedVia: 'trusted_storage_ticket',
        }
      )
    } finally {
      await app.close()
    }
  })
})
