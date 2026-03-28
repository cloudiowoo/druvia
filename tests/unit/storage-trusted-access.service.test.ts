import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/storage/storage.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../apps/api/src/modules/storage/storage.service.js')>(
    '../../apps/api/src/modules/storage/storage.service.js'
  )

  return {
    ...actual,
    getBucketByName: vi.fn(),
  }
})

import { queryOne } from '../../apps/api/src/db/index.js'
import { config } from '../../apps/api/src/config/index.js'
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js'
import { getBucketByName } from '../../apps/api/src/modules/storage/storage.service.js'
import {
  issueRemoveTicket,
  issueUploadTicket,
  StorageTrustedAccessError,
  verifyRemoveTicket,
  verifyUploadTicket,
} from '../../apps/api/src/modules/storage/storage-trusted-access.service.js'

describe('storage trusted access service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    config.storage.trustedTicketSecret = 'test_storage_trusted_ticket_secret'
    vi.mocked(getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_default_taroapp',
    } as Awaited<ReturnType<typeof getProjectById>>)
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return { column_name: 'status' } as never
      }
      return { id: 'usr_proj_1' } as never
    })
    vi.mocked(getBucketByName).mockResolvedValue({
      id: 1,
      bucketId: 'bucket_123',
      projectId: 'proj_123',
      name: 'team-assets',
      public: true,
      fileSizeLimit: 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
      corsConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('rejects unknown users when issuing upload tickets', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return { column_name: 'status' } as never
      }
      return null as never
    })

    await expect(
      issueUploadTicket({
        projectId: 'proj_123',
        userId: 'usr_missing',
        bucket: 'team-assets',
        pathPrefix: 'user-avatars/',
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('rejects disabled users when issuing upload tickets', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return { column_name: 'status' } as never
      }
      return null as never
    })

    await expect(
      issueUploadTicket({
        projectId: 'proj_123',
        userId: 'usr_disabled',
        bucket: 'team-assets',
        pathPrefix: 'user-avatars/',
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    })
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining(`WHERE id = $1 AND status = 'active' LIMIT 1`),
      ['usr_disabled']
    )
  })

  it('rejects unknown buckets when issuing upload tickets', async () => {
    vi.mocked(getBucketByName).mockResolvedValueOnce(null)

    await expect(
      issueUploadTicket({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'missing-bucket',
        pathPrefix: 'user-avatars/',
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'BUCKET_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('validates upload pathPrefix', async () => {
    await expect(
      issueUploadTicket({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'team-assets',
        pathPrefix: '../user-avatars',
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'INVALID_PATH_PREFIX',
      statusCode: 400,
    })
  })

  it('enforces the trusted ticket ttl cap', async () => {
    await expect(
      issueUploadTicket({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'team-assets',
        pathPrefix: 'user-avatars/',
        expiresIn: 5000,
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'TTL_TOO_LARGE',
      statusCode: 400,
    })
  })

  it('requires a valid exact path for remove tickets', async () => {
    await expect(
      issueRemoveTicket({
        projectId: 'proj_123',
        userId: 'usr_proj_1',
        bucket: 'team-assets',
        path: '../user-avatars/avatar.png',
        issuedBy: 'drutb_123',
      })
    ).rejects.toMatchObject<StorageTrustedAccessError>({
      code: 'INVALID_PATH',
      statusCode: 400,
    })
  })

  it('rejects expired and tampered tickets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T12:00:00.000Z'))

    const uploadTicket = await issueUploadTicket({
      projectId: 'proj_123',
      userId: 'usr_proj_1',
      bucket: 'team-assets',
      pathPrefix: 'user-avatars/',
      expiresIn: 1,
      issuedBy: 'drutb_123',
    })
    const removeTicket = await issueRemoveTicket({
      projectId: 'proj_123',
      userId: 'usr_proj_1',
      bucket: 'team-assets',
      path: 'user-avatars/avatar.png',
      expiresIn: 300,
      issuedBy: 'drutb_123',
    })

    vi.setSystemTime(new Date('2026-03-28T12:00:02.000Z'))

    try {
      verifyUploadTicket(uploadTicket.ticket)
      throw new Error('expected upload ticket to be rejected')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_TICKET',
        statusCode: 401,
      })
    }

    try {
      verifyRemoveTicket(`${removeTicket.ticket}tampered`)
      throw new Error('expected remove ticket to be rejected')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_TICKET',
        statusCode: 401,
      })
    }
  })

  it('issues and verifies normalized upload ticket claims', async () => {
    const result = await issueUploadTicket({
      projectId: 'proj_123',
      userId: 'usr_proj_1',
      bucket: 'team-assets',
      pathPrefix: 'user-avatars',
      contentTypes: ['image/png'],
      maxBytes: 2048,
      issuedBy: 'drutb_123',
    })

    const payload = verifyUploadTicket(result.ticket)

    expect(payload.pathPrefix).toBe('user-avatars/')
    expect(payload.maxBytes).toBe(1024)
    expect(payload.contentTypes).toEqual(['image/png'])
  })
})
