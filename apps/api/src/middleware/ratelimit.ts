import type { FastifyRequest, FastifyReply } from 'fastify';
import type { JwtPayload } from './auth.js';
import { redis } from '../lib/redis.js';

export interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix?: string;    // Redis key prefix
}

// Default rate limit config
const defaultConfig: RateLimitConfig = {
  windowMs: 60 * 1000,   // 1 minute
  maxRequests: 100,      // 100 requests per minute
  keyPrefix: 'ratelimit',
};

// Generate rate limit key
function getRateLimitKey(prefix: string, identifier: string): string {
  return `${prefix}:${identifier}`;
}

// Rate limit middleware factory
export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests, keyPrefix } = { ...defaultConfig, ...config };
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function rateLimiter(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Get identifier (user ID, tenant ID, or IP)
    const identifier = (request.user as JwtPayload | undefined)?.userId || request.ip;
    const key = getRateLimitKey(keyPrefix!, identifier);

    try {
      // Increment counter
      const current = await redis.incr(key);

      // Set expiry on first request
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      // Get TTL for headers
      const ttl = await redis.ttl(key);

      // Set rate limit headers
      reply.header('X-RateLimit-Limit', maxRequests);
      reply.header('X-RateLimit-Remaining', Math.max(0, maxRequests - current));
      reply.header('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + ttl);

      // Check if over limit
      if (current > maxRequests) {
        return reply.status(429).send({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests, please try again later',
          },
        });
      }
    } catch (error) {
      // If Redis fails, allow the request (fail open)
      console.error('Rate limiter error:', error);
    }
  };
}

// Tenant-level rate limiter
export function createTenantRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests, keyPrefix } = {
    ...defaultConfig,
    keyPrefix: 'ratelimit:tenant',
    ...config,
  };
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function tenantRateLimiter(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Get tenant ID from params or user context
    const tenantId = (request.params as { tenantId?: string })?.tenantId || (request.user as JwtPayload | undefined)?.tenantId;

    if (!tenantId) {
      return; // Skip if no tenant context
    }

    const key = getRateLimitKey(keyPrefix!, tenantId);

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      const ttl = await redis.ttl(key);

      reply.header('X-RateLimit-Limit', maxRequests);
      reply.header('X-RateLimit-Remaining', Math.max(0, maxRequests - current));
      reply.header('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + ttl);

      if (current > maxRequests) {
        return reply.status(429).send({
          success: false,
          error: {
            code: 'TENANT_RATE_LIMIT_EXCEEDED',
            message: 'Tenant rate limit exceeded',
          },
        });
      }
    } catch (error) {
      console.error('Tenant rate limiter error:', error);
    }
  };
}

// API endpoint rate limiter (stricter)
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 100,
  keyPrefix: 'ratelimit:api',
});

// Auth endpoint rate limiter (very strict)
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,          // 10 attempts
  keyPrefix: 'ratelimit:auth',
});

// File upload rate limiter
export const uploadRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: 'ratelimit:upload',
});
