import { describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    on: vi.fn(),
    quit: vi.fn(),
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
}))

import { appCorsOptions, buildApp } from '../../apps/api/src/index.js'

describe('API app CORS', () => {
  it('includes the apikey header in the allowed CORS headers', () => {
    expect(appCorsOptions.allowedHeaders).toContain('apikey')
  })
})

describe('API app internal functions route', () => {
  it('registers the internal functions graphql route', async () => {
    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
