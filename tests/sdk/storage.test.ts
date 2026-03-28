import { describe, it, expect, vi } from 'vitest'
import { DruviaStorage } from '../../packages/sdk/src/modules/storage.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

function createMockFetch(responseData: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
    blob: async () => new Blob(['file-content']),
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
  } as unknown as Response)
}

describe('DruviaStorage', () => {
  const projectId = 'proj_123'

  it('from() returns a BucketClient', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const bucket = storage.from('team-assets')
    expect(bucket).toBeDefined()
    expect(typeof bucket.upload).toBe('function')
    expect(typeof bucket.download).toBe('function')
    expect(typeof bucket.getPublicUrl).toBe('function')
  })

  it('upload sends POST to storage endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { path: 'avatar.png' } })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').upload('avatar.png', new Blob(['img']))
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/objects?path=avatar.png`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.error).toBeNull()
  })

  it('download sends GET to storage endpoint', async () => {
    const fetch = createMockFetch({})
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').download('avatar.png')
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/objects/avatar.png`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.error).toBeNull()
  })

  it('getPublicUrl returns URL string', () => {
    const fetch = vi.fn() as unknown as FetchFn
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const { data } = storage.from('team-assets').getPublicUrl('avatar.png')
    expect(data?.publicUrl).toContain('team-assets')
    expect(data?.publicUrl).toContain('avatar.png')
  })

  it('createSignedUrl sends POST', async () => {
    const fetch = createMockFetch({ success: true, data: { signedUrl: 'https://example.com/signed' } })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)
    const result = await storage.from('team-assets').createSignedUrl('avatar.png', 3600)
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/signed-url`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.data?.signedUrl).toBeTruthy()
  })

  it('issueUploadTicket sends trusted backend key header', async () => {
    const fetch = createMockFetch({
      success: true,
      data: {
        ticket: 'upload-ticket',
        expiresIn: 300,
        expiresAt: '2026-03-28T12:00:00.000Z',
        payload: {
          purpose: 'upload',
          projectId,
          projectUserId: 'usr_proj_1',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
          issuedBy: 'drutb_123',
          issuedVia: 'trusted_storage_ticket',
        },
      },
    })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)

    const result = await storage.issueUploadTicket({
      userId: 'usr_proj_1',
      bucket: 'team-assets',
      pathPrefix: 'user-avatars/',
      trustedBackendKey: 'drutb_secret',
    })

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/storage/trusted/upload-ticket`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
      })
    )
  })

  it('uploadWithTicket sends storage ticket header', async () => {
    const fetch = createMockFetch({
      success: true,
      data: {
        path: 'user-avatars/avatar.png',
        publicUrl: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/user-avatars/avatar.png',
        object: {
          objectId: 'obj_123',
          bucketId: 'bucket_123',
          name: 'user-avatars/avatar.png',
          size: 3,
          mimeType: 'image/png',
          createdAt: '2026-03-28T12:00:00.000Z',
        },
      },
    })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)

    const result = await storage.uploadWithTicket('storage-ticket', new Blob(['img']), {
      path: 'user-avatars/avatar.png',
      contentType: 'image/png',
    })

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/storage/upload-with-ticket?path=user-avatars%2Favatar.png`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'x-druvia-storage-ticket': 'storage-ticket',
        },
      })
    )
  })

  it('removeWithTicket sends storage ticket header', async () => {
    const fetch = createMockFetch({ success: true, data: { removed: true } })
    const storage = new DruviaStorage('/api/v1', projectId, fetch)

    const result = await storage.removeWithTicket('storage-ticket', 'user-avatars/avatar.png')

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/storage/remove-with-ticket`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-storage-ticket': 'storage-ticket',
        },
        body: JSON.stringify({ path: 'user-avatars/avatar.png' }),
      })
    )
  })
})
