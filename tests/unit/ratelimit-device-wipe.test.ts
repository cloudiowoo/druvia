import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithApiLogContext } from '../../apps/api/src/lib/log-context.js';

const { redisMock, loggerError } = vi.hoisted(() => ({
  redisMock: {
    eval: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
  loggerError: vi.fn(),
}));

vi.mock('../../apps/api/src/lib/redis.js', () => ({ redis: redisMock }));
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({ error: loggerError })),
}));

import {
  deviceWipeBindingRateLimiter,
  deviceWipeLookupRateLimiter,
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

describe('project device wipe rate limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.eval.mockResolvedValue([1, 60]);
  });

  it('isolates session-independent lookups by project, binding handle and IP', async () => {
    await deviceWipeLookupRateLimiter({
      id: 'req-1',
      ip: '198.51.100.8',
      params: { projectId: 'proj-1', bindingHandle: 'dwb_binding-1' },
    } as never, createReply() as never);

    const handleDigest = createHash('sha256').update('dwb_binding-1').digest('hex').slice(0, 32);
    expect(redisMock.eval.mock.calls.map((call) => call.slice(2))).toEqual([
      ['ratelimit:device-wipe-lookup:ip:198.51.100.8', '60'],
      ['ratelimit:device-wipe-lookup:project:proj-1:198.51.100.8', '60'],
      [`ratelimit:device-wipe-lookup:binding:${handleDigest}:198.51.100.8`, '60'],
    ]);
    expect(redisMock.incr).not.toHaveBeenCalled();
    expect(redisMock.expire).not.toHaveBeenCalled();
  });

  it('limits an IP within a project even when the attacker changes handles', async () => {
    redisMock.eval.mockImplementation(async (_script: string, _keys: number, key: string) => (
      key.includes(':project:') ? [241, 60] : [1, 60]
    ));
    const reply = createReply();

    await deviceWipeLookupRateLimiter({
      id: 'req-2',
      ip: '198.51.100.9',
      params: { projectId: 'proj-1', bindingHandle: 'dwb_random-handle' },
    } as never, reply as never);

    expect(reply.statusCode).toBe(429);
    expect(redisMock.eval.mock.calls[1]?.[2]).toBe(
      'ratelimit:device-wipe-lookup:project:proj-1:198.51.100.9',
    );
    expect(redisMock.eval).toHaveBeenCalledTimes(2);
  });

  it('returns a device-wipe-specific error after the lookup limit', async () => {
    redisMock.eval.mockResolvedValue([121, 60]);
    const reply = createReply();

    await deviceWipeLookupRateLimiter({
      id: 'req-3',
      ip: '198.51.100.9',
      params: { projectId: 'proj-1', bindingHandle: 'dwb_binding-1' },
    } as never, reply as never);

    expect(reply.statusCode).toBe(429);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'DEVICE_WIPE_RATE_LIMITED',
        message: 'Device wipe request rate exceeded',
      },
    });
  });

  it('uses one atomic Redis script that repairs a missing expiry', async () => {
    await deviceWipeLookupRateLimiter({
      id: 'req-atomic',
      ip: '198.51.100.10',
      params: { projectId: 'proj-1', bindingHandle: 'dwb_binding-1' },
    } as never, createReply() as never);

    const script = String(redisMock.eval.mock.calls[0]?.[0]);
    expect(script).toContain("redis.call('INCR', KEYS[1])")
    expect(script).toContain("if current == 1 or ttl < 0 then")
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], window_seconds)")
  });

  it('suppresses the authenticated Project User when registration limiting fails', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    const reply = createReply();
    const request = {
      id: 'req-registration',
      ip: '198.51.100.11',
      params: { projectId: 'proj-1' },
      user: {
        kind: 'project_user',
        sub: 'raw-project-user-id',
        projectId: 'proj-1',
      },
    };

    await runWithApiLogContext({ projectUserId: 'raw-project-user-id' }, () => (
      deviceWipeBindingRateLimiter(request as never, reply as never)
    ));

    expect(loggerError).toHaveBeenCalledWith(
      'device wipe binding rate limiter error',
      expect.objectContaining({
        requestId: 'req-registration',
        projectId: 'proj-1',
        projectUserId: undefined,
      }),
      expect.any(Error),
    );
    expect(reply.statusCode).toBe(503);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'DEVICE_WIPE_RATE_LIMIT_UNAVAILABLE',
        message: 'Device wipe request is temporarily unavailable',
      },
    });
  });

  it('fails closed when lookup limiting cannot reach Redis', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    const reply = createReply();

    await deviceWipeLookupRateLimiter({
      id: 'req-lookup-unavailable',
      ip: '198.51.100.12',
      params: { projectId: 'proj-1', bindingHandle: 'dwb_binding-1' },
    } as never, reply as never);

    expect(reply.statusCode).toBe(503);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'DEVICE_WIPE_RATE_LIMIT_UNAVAILABLE',
        message: 'Device wipe request is temporarily unavailable',
      },
    });
  });
});
