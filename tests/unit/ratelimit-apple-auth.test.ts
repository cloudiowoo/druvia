import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}));

vi.mock('../../apps/api/src/lib/redis.js', () => ({ redis: redisMock }));

import {
  appleLoginRateLimiter,
  appleNotificationRateLimiter,
  appleRevokeRateLimiter,
} from '../../apps/api/src/middleware/ratelimit.js';

function createReply() {
  const reply = { header: vi.fn(), status: vi.fn(), send: vi.fn(), statusCode: 0 };
  reply.header.mockReturnValue(reply);
  reply.status.mockImplementation((statusCode: number) => {
    reply.statusCode = statusCode;
    return reply;
  });
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('Apple Project Auth rate limiters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.incr.mockResolvedValue(1);
    redisMock.expire.mockResolvedValue(1);
    redisMock.ttl.mockResolvedValue(60);
  });

  it('isolates anonymous login and notification buckets by project and IP', async () => {
    const request = { id: 'req-1', ip: '198.51.100.8', params: { projectId: 'proj-1' } };

    await appleLoginRateLimiter(request as never, createReply() as never);
    await appleNotificationRateLimiter(request as never, createReply() as never);

    expect(redisMock.incr).toHaveBeenNthCalledWith(
      1,
      'ratelimit:apple-login:proj-1:ip:198.51.100.8',
    );
    expect(redisMock.incr).toHaveBeenNthCalledWith(
      2,
      'ratelimit:apple-notification:proj-1:ip:198.51.100.8',
    );
  });

  it('uses the authenticated Project User for revoke and returns the Apple error code', async () => {
    redisMock.incr.mockResolvedValue(11);
    const reply = createReply();
    const request = {
      id: 'req-2',
      ip: '198.51.100.9',
      params: { projectId: 'proj-1' },
      user: { kind: 'project_user', sub: 'project-user-1' },
    };

    await appleRevokeRateLimiter(request as never, reply as never);

    expect(redisMock.incr).toHaveBeenCalledWith(
      'ratelimit:apple-revoke:proj-1:user:project-user-1',
    );
    expect(reply.statusCode).toBe(429);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'PROVIDER_RATE_LIMITED',
        message: 'Apple authentication rate limit exceeded',
      },
    });
  });
});
