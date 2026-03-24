import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  authenticateMock,
  isJwtUserMock,
  checkProjectAccessMock,
  getProjectByIdMock,
  checkProjectGraphqlRateLimitMock,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  isJwtUserMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
  getProjectByIdMock: vi.fn(),
  checkProjectGraphqlRateLimitMock: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/modules/openapi/openapi.service.js', () => ({
  generateProjectOpenApi: vi.fn(),
}))

vi.mock('../../apps/api/src/middleware/auth.js', () => ({
  authenticate: authenticateMock,
  isJwtUser: isJwtUserMock,
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: checkProjectAccessMock,
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: getProjectByIdMock,
}))

vi.mock('../../apps/api/src/middleware/ratelimit.js', async () => {
  const actual = await vi.importActual<typeof import('../../apps/api/src/middleware/ratelimit.js')>(
    '../../apps/api/src/middleware/ratelimit.js'
  )

  return {
    ...actual,
    checkProjectGraphqlRateLimit: checkProjectGraphqlRateLimitMock,
  }
})

import { openapiRoutes } from '../../apps/api/src/modules/openapi/openapi.routes.js'

describe('OpenAPI GraphQL proxy route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())

    authenticateMock.mockImplementation(async (request, reply) => {
      const apiKey = request.headers.apikey
      if (!apiKey) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }

      request.user = {
        kind: 'apikey',
        projectId: 'proj_123',
        role: 'anon',
      }
    })
    isJwtUserMock.mockReturnValue(false)
    checkProjectAccessMock.mockResolvedValue(true)
    getProjectByIdMock.mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      settings: {
        rateLimits: {
          graphql: { perUser: 120, perProject: 1000 },
        },
      },
    })
    checkProjectGraphqlRateLimitMock.mockImplementation(async () => {})
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { __typename: 'query_root' } }),
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('continues past apikey project validation to load project and proxy graphql', async () => {
    const app = Fastify()
    await app.register(openapiRoutes, { prefix: '/api/v1' })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/graphql',
        headers: {
          apikey: 'test-key',
        },
        payload: {
          query: 'query { __typename }',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(getProjectByIdMock).toHaveBeenCalledWith('proj_123')
      expect(checkProjectGraphqlRateLimitMock).toHaveBeenCalledTimes(1)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })
})
