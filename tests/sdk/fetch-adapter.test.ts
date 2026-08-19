import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchWrapper } from '../../packages/sdk/src/lib/fetch-adapter.js'

describe('SDK fetch adapter runtime compatibility', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends JSON requests when the runtime has no global FormData', async () => {
    vi.stubGlobal('FormData', undefined)
    const rawFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapped = createFetchWrapper(
      'https://api.example.com/api/v1',
      'project-api-key',
      rawFetch,
      () => 'project-session'
    )

    await expect(wrapped('/projects/proj_1/storage/signed-url', {
      method: 'POST',
      body: JSON.stringify({ objectPath: 'a.png', expiresIn: 60 }),
    })).resolves.toBeInstanceOf(Response)

    const init = rawFetch.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer project-session')
    expect(headers.get('apikey')).toBe('project-api-key')
  })
})
