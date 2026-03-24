import { beforeEach, describe, expect, it, vi } from 'vitest'

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: redisMock,
}))

import { checkProjectGraphqlRateLimit } from '../../apps/api/src/middleware/ratelimit.js'

type ReplyStub = {
  headers: Record<string, unknown>
  sent: boolean
  statusCode?: number
  payload?: unknown
  header: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function createReply(): ReplyStub {
  const reply: ReplyStub = {
    headers: {},
    sent: false,
    header: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
  }

  reply.header.mockImplementation((key: string, value: unknown) => {
    reply.headers[key] = value
    return reply
  })

  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code
    return reply
  })

  reply.send.mockImplementation((payload: unknown) => {
    reply.payload = payload
    reply.sent = true
    return reply
  })

  return reply
}

describe('GraphQL project rate limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.incr.mockResolvedValue(1)
    redisMock.expire.mockResolvedValue(1)
    redisMock.ttl.mockResolvedValue(60)
  })

  it('scopes per-user counters by project for platform users', async () => {
    const reply = createReply()
    const request = {
      ip: '127.0.0.1',
      user: {
        kind: 'platform_user',
        userId: 'usr_admin',
        uid: 1,
      },
    }

    await checkProjectGraphqlRateLimit(request as never, reply as never, 'proj_123', {
      perUser: 60,
      perProject: 0,
    })

    expect(redisMock.incr).toHaveBeenCalledWith('ratelimit:graphql:proj_123:platform:usr_admin')
    expect(reply.headers['X-RateLimit-Limit']).toBe(60)
  })

  it('scopes per-user counters by project for project users and anonymous apikey callers', async () => {
    const reply = createReply()

    await checkProjectGraphqlRateLimit(
      {
        ip: '10.0.0.8',
        user: {
          kind: 'project_user',
          sub: 'usr_proj_1',
          projectId: 'proj_123',
          authType: 'project_user',
          role: 'authenticated',
          provider: 'wechat',
        },
      } as never,
      reply as never,
      'proj_123',
      { perUser: 30, perProject: 0 }
    )

    expect(redisMock.incr).toHaveBeenNthCalledWith(1, 'ratelimit:graphql:proj_123:project:usr_proj_1')

    await checkProjectGraphqlRateLimit(
      {
        ip: '10.0.0.9',
        user: {
          kind: 'apikey',
          projectId: 'proj_123',
          role: 'anon',
        },
      } as never,
      createReply() as never,
      'proj_123',
      { perUser: 30, perProject: 0 }
    )

    expect(redisMock.incr).toHaveBeenNthCalledWith(2, 'ratelimit:graphql:proj_123:anon-ip:10.0.0.9')
  })

  it('tracks project-wide counters separately and returns 429 when user limit is exceeded', async () => {
    redisMock.incr
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(8)
    const reply = createReply()

    await checkProjectGraphqlRateLimit(
      {
        ip: '127.0.0.1',
        user: {
          kind: 'platform_user',
          userId: 'usr_admin',
          uid: 1,
        },
      } as never,
      reply as never,
      'proj_999',
      { perUser: 2, perProject: 10 }
    )

    expect(redisMock.incr).toHaveBeenCalledWith('ratelimit:graphql:proj_999:platform:usr_admin')
    expect(redisMock.incr).not.toHaveBeenCalledWith('ratelimit:graphql:project:proj_999')
    expect(reply.statusCode).toBe(429)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'GRAPHQL_USER_RATE_LIMIT_EXCEEDED',
        message: 'User rate limit exceeded for GraphQL API',
      },
    })
  })
})
