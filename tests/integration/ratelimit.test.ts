import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { redis } from '../../apps/api/src/lib/redis.js';
import { createRateLimiter, createTenantRateLimiter } from '../../apps/api/src/middleware/ratelimit.js';
import Fastify from 'fastify';

describe('RateLimit Integration', () => {
  const app = Fastify();

  beforeAll(async () => {
    // Set up test routes with rate limiting
    const strictLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 3,
      keyPrefix: 'test:ratelimit',
    });

    app.get('/test/limited', { preHandler: strictLimiter }, async () => {
      return { success: true };
    });

    const tenantLimiter = createTenantRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 2,
      keyPrefix: 'test:tenant',
    });

    app.get('/test/tenant/:tenantId', { preHandler: tenantLimiter }, async () => {
      return { success: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    // Clean up test keys
    const keys = await redis.keys('test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await app.close();
  });

  beforeEach(async () => {
    // Clean up test keys before each test
    const keys = await redis.keys('test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe('Redis connection', () => {
    it('should connect to Redis', async () => {
      const pong = await redis.ping();
      expect(pong).toBe('PONG');
    });

    it('should set and get values', async () => {
      await redis.set('test:key', 'value');
      const value = await redis.get('test:key');
      expect(value).toBe('value');
    });
  });

  describe('Rate limiter middleware', () => {
    it('should allow requests under limit', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.100',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe('3');
      expect(response.headers['x-ratelimit-remaining']).toBe('2');
    });

    it('should block requests over limit', async () => {
      // Make 3 requests (at limit)
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'GET',
          url: '/test/limited',
          remoteAddress: '192.168.1.101',
        });
      }

      // 4th request should be blocked
      const response = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.101',
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should track different IPs separately', async () => {
      // Max out IP 1
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'GET',
          url: '/test/limited',
          remoteAddress: '192.168.1.102',
        });
      }

      // IP 2 should still work
      const response = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.103',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Tenant rate limiter', () => {
    it('should limit by tenant ID', async () => {
      // Make 2 requests (at limit)
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'GET',
          url: '/test/tenant/tenant_abc',
        });
      }

      // 3rd request should be blocked
      const response = await app.inject({
        method: 'GET',
        url: '/test/tenant/tenant_abc',
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('TENANT_RATE_LIMIT_EXCEEDED');
    });

    it('should track different tenants separately', async () => {
      // Max out tenant A
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'GET',
          url: '/test/tenant/tenant_a',
        });
      }

      // Tenant B should still work
      const response = await app.inject({
        method: 'GET',
        url: '/test/tenant/tenant_b',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Rate limit headers', () => {
    it('should include rate limit headers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.200',
      });

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should decrement remaining count', async () => {
      const response1 = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.201',
      });
      expect(response1.headers['x-ratelimit-remaining']).toBe('2');

      const response2 = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.201',
      });
      expect(response2.headers['x-ratelimit-remaining']).toBe('1');

      const response3 = await app.inject({
        method: 'GET',
        url: '/test/limited',
        remoteAddress: '192.168.1.201',
      });
      expect(response3.headers['x-ratelimit-remaining']).toBe('0');
    });
  });
});
