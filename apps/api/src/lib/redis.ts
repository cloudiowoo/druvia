import RedisClient from 'ioredis';
import { config } from '../config/index.js';
import { createApiLogger } from './logger.js';

const logger = createApiLogger({ module: 'redis' });

// Create Redis client
const Redis = RedisClient.default || RedisClient;
export const redis = new Redis(config.redis.url);

// Connect to Redis (ioredis auto-connects)
export async function connectRedis(): Promise<void> {
  return new Promise((resolve, reject) => {
    redis.on('connect', () => {
      logger.info('redis connected');
      resolve();
    });
    redis.on('error', (err: Error) => {
      logger.error('redis connection error', undefined, err);
      reject(err);
    });
  });
}

// Disconnect from Redis
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

// Cache helpers
export async function getCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data) as T;
}

export async function setCache<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function deleteCache(key: string): Promise<void> {
  await redis.del(key);
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
