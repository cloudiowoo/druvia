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
      `/api/v1/projects/${projectId}/storage/buckets/team-assets/objects/avatar.png`,
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
})
