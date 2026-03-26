import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDruviaHelper, resolveDruviaApiBaseUrl } from '../../docker/deno-worker/druvia-helper.ts'

describe('Druvia Worker Helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('posts graphql requests to the internal functions proxy with the internal token', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { ok: true }, errors: null }),
    } as never)

    const druvia = createDruviaHelper({
      apiBaseUrl: 'http://localhost:3001',
      internalToken: 'internal-token',
      fetchFn: global.fetch,
    })

    const result = await druvia.graphql('query Test($id: Int!) { demo_by_pk(id: $id) { id } }', { id: 1 })

    expect(result).toEqual({ data: { ok: true }, errors: null })
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/internal/functions/graphql',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-internal-token': 'internal-token',
        },
        body: JSON.stringify({
          query: 'query Test($id: Int!) { demo_by_pk(id: $id) { id } }',
          variables: { id: 1 },
        }),
      }
    )
  })

  it('uploads binary data through the internal storage proxy with trusted caller context', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: vi.fn().mockReturnValue('application/json'),
      },
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          path: 'avatars/a.png',
          publicUrl: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/avatars/a.png',
          object: { objectId: 'obj_123' },
        },
      }),
    } as never)

    const druvia = createDruviaHelper({
      apiBaseUrl: 'http://localhost:3001',
      internalToken: 'internal-token',
      fetchFn: global.fetch,
    })

    const result = await druvia.storage.upload({
      bucket: 'team-assets',
      path: 'avatars/a.png',
      data: new Uint8Array([102, 105, 108, 101]),
      contentType: 'image/png',
    })

    expect(result).toEqual({
      path: 'avatars/a.png',
      publicUrl: 'http://localhost:3001/api/v1/storage/public/proj_123/team-assets/avatars/a.png',
      object: { objectId: 'obj_123' },
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/internal/functions/storage/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-internal-token': 'internal-token',
        },
        body: JSON.stringify({
          bucket: 'team-assets',
          path: 'avatars/a.png',
          contentType: 'image/png',
          dataBase64: 'ZmlsZQ==',
        }),
      }
    )
  })

  it('falls back to the worker DRUVIA_API_URL when invoke does not pass apiBaseUrl', () => {
    const envGet = vi.fn().mockReturnValue('http://api:3001')

    const apiBaseUrl = resolveDruviaApiBaseUrl(undefined, envGet)

    expect(apiBaseUrl).toBe('http://api:3001')
    expect(envGet).toHaveBeenCalledWith('DRUVIA_API_URL')
  })

  it('removes objects through the internal storage proxy', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: vi.fn().mockReturnValue('application/json'),
      },
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          path: 'avatars/old.png',
          deleted: true,
        },
      }),
    } as never)

    const druvia = createDruviaHelper({
      apiBaseUrl: 'http://localhost:3001',
      internalToken: 'internal-token',
      fetchFn: global.fetch,
    })

    const result = await druvia.storage.remove({
      bucket: 'team-assets',
      path: 'avatars/old.png',
      ignoreMissing: true,
    })

    expect(result).toEqual({
      path: 'avatars/old.png',
      deleted: true,
    })
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/internal/functions/storage/remove',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-internal-token': 'internal-token',
        },
        body: JSON.stringify({
          bucket: 'team-assets',
          path: 'avatars/old.png',
          ignoreMissing: true,
        }),
      }
    )
  })
})
