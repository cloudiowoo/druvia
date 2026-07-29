import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    on: vi.fn(),
    quit: vi.fn(),
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
}));

import { buildApp } from '../../apps/api/src/index.js';
import { config } from '../../apps/api/src/config/index.js';
import { signProjectUserToken, signToken } from '../../apps/api/src/middleware/auth.js';

describe('API system update proxy', () => {
  const originalJwtSecret = config.jwt.secret;
  const originalProjectTokenSecret = config.projectAuth.tokenSecret;

  beforeEach(() => {
    config.jwt.secret = 'test-jwt-secret-test-jwt-secret';
    config.projectAuth.tokenSecret = 'test-project-secret-test-project-secret';
    config.updater.url = 'http://updater:3010';
    config.updater.secret = 'updater-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.jwt.secret = originalJwtSecret;
    config.projectAuth.tokenSecret = originalProjectTokenSecret;
  });

  it('allows super_admin platform users to read update status through the internal updater secret', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('http://updater:3010/internal/update/status');
      expect(init?.headers).toEqual({ 'x-druvia-updater-secret': 'updater-secret' });
      return new Response(JSON.stringify({ phase: 'idle', currentVersion: '0.1.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();
    const token = signToken({ userId: 'user_1', uid: 1, role: 'super_admin' });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/system/update/status',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: { phase: 'idle', currentVersion: '0.1.0' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects non-super-admin platform users before contacting updater', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();
    const token = signToken({ userId: 'user_1', uid: 1, role: 'member' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update/check',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects project users before contacting updater', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = buildApp();
    const token = signProjectUserToken({
      sub: 'project_user_1',
      projectId: 'proj_1',
      authType: 'project_user',
      role: 'authenticated',
      provider: 'wechat',
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/restart',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves updater status codes for mutating operations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ operationId: 'op-1' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })));
    const app = buildApp();
    const token = signToken({ userId: 'user_1', uid: 1, role: 'super_admin' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update/download',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ success: true, data: { operationId: 'op-1' } });
    } finally {
      await app.close();
    }
  });

  it('wraps updater errors in the standard API error envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'UPDATE_IN_PROGRESS', message: 'Update operation is already in progress' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));
    const app = buildApp();
    const token = signToken({ userId: 'user_1', uid: 1, role: 'super_admin' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/system/update/apply',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'UPDATE_IN_PROGRESS', message: 'Update operation is already in progress' },
      });
    } finally {
      await app.close();
    }
  });
});
