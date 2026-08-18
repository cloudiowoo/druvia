import { beforeEach, describe, expect, it, vi } from 'vitest'

const { redisMock, loggerMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
  loggerMock: {
    error: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/lib/redis.js', () => ({ redis: redisMock }))
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => loggerMock),
}))

import { checkRealtimeTokenRateLimit } from '../../apps/api/src/middleware/ratelimit.js'

function createReply() {
  const reply = {
    headers: {} as Record<string, unknown>,
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    header: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
  }
  reply.header.mockImplementation((key: string, value: unknown) => {
    reply.headers[key] = value
    return reply
  })
  reply.status.mockImplementation((statusCode: number) => {
    reply.statusCode = statusCode
    return reply
  })
  reply.send.mockImplementation((payload: unknown) => {
    reply.payload = payload
    return reply
  })
  return reply
}

const projectUserRequest = {
  id: 'req_123',
  ip: '198.51.100.24',
  user: {
    kind: 'project_user' as const,
    sub: 'usr_project_1',
    projectId: 'proj_123',
    authType: 'project_user' as const,
    role: 'authenticated' as const,
    provider: 'wechat',
  },
}

describe('Realtime token exchange rate limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.incr.mockResolvedValue(1)
    redisMock.expire.mockResolvedValue(1)
    redisMock.ttl.mockResolvedValue(60)
  })

  it('increments actor and project buckets for a project user', async () => {
    const reply = createReply()

    await checkRealtimeTokenRateLimit(projectUserRequest as never, reply as never, 'proj_123')

    expect(redisMock.incr).toHaveBeenNthCalledWith(
      1,
      'ratelimit:realtime-token:proj_123:project:usr_project_1'
    )
    expect(redisMock.incr).toHaveBeenNthCalledWith(
      2,
      'ratelimit:realtime-token:project:proj_123'
    )
    expect(reply.headers).toMatchObject({
      'X-RateLimit-Limit': 30,
      'X-RateLimit-Remaining': 29,
    })
  })

  it('uses the trusted request IP for API-key identity', async () => {
    await checkRealtimeTokenRateLimit({
      id: 'req_anon',
      ip: '198.51.100.24',
      user: {
        kind: 'apikey',
        projectId: 'proj_123',
        role: 'anon',
        apiKeyId: 42,
        apiKeyPrefix: 'dru_fixture1',
      },
    } as never, createReply() as never, 'proj_123')

    expect(redisMock.incr).toHaveBeenNthCalledWith(
      1,
      'ratelimit:realtime-token:proj_123:anon-ip:198.51.100.24'
    )
  })

  it('rejects request 31 and does not consume the project bucket', async () => {
    redisMock.incr.mockResolvedValueOnce(31)
    redisMock.ttl.mockResolvedValueOnce(42)
    const reply = createReply()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    await checkRealtimeTokenRateLimit(projectUserRequest as never, reply as never, 'proj_123')

    expect(redisMock.incr).toHaveBeenCalledTimes(1)
    expect(reply.statusCode).toBe(429)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'REALTIME_TOKEN_RATE_LIMIT_EXCEEDED',
        message: 'Realtime token rate limit exceeded',
      },
    })
    expect(reply.headers).toMatchObject({
      'Retry-After': 42,
      'X-RateLimit-Limit': 30,
      'X-RateLimit-Remaining': 0,
      'X-RateLimit-Reset': 1_700_000_042,
    })
    now.mockRestore()
  })

  it('rejects project request 301 and replaces actor headers', async () => {
    redisMock.incr.mockResolvedValueOnce(4).mockResolvedValueOnce(301)
    redisMock.ttl.mockResolvedValueOnce(55).mockResolvedValueOnce(17)
    const reply = createReply()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    await checkRealtimeTokenRateLimit(projectUserRequest as never, reply as never, 'proj_123')

    expect(reply.statusCode).toBe(429)
    expect(reply.headers).toMatchObject({
      'Retry-After': 17,
      'X-RateLimit-Limit': 300,
      'X-RateLimit-Remaining': 0,
      'X-RateLimit-Reset': 1_700_000_017,
    })
  })

  it('fails open and logs request/project context when Redis is unavailable', async () => {
    const error = new Error('redis unavailable')
    redisMock.incr.mockRejectedValue(error)
    const reply = createReply()

    await expect(checkRealtimeTokenRateLimit(
      projectUserRequest as never,
      reply as never,
      'proj_123'
    )).resolves.toBeUndefined()

    expect(reply.send).not.toHaveBeenCalled()
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Realtime token rate limiter error',
      { requestId: 'req_123', projectId: 'proj_123' },
      error
    )
  })
})
