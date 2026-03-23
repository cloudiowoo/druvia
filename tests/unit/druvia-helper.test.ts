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

  it('falls back to the worker DRUVIA_API_URL when invoke does not pass apiBaseUrl', () => {
    const envGet = vi.fn().mockReturnValue('http://api:3001')

    const apiBaseUrl = resolveDruviaApiBaseUrl(undefined, envGet)

    expect(apiBaseUrl).toBe('http://api:3001')
    expect(envGet).toHaveBeenCalledWith('DRUVIA_API_URL')
  })
})
