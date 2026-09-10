import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../.env') });

function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function resolveRealtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawTtl = Number.parseInt(env.HASURA_REALTIME_TOKEN_TTL_SECONDS || '300', 10);
  const tokenTtlSeconds = Number.isFinite(rawTtl)
    ? Math.min(900, Math.max(60, rawTtl))
    : 300;
  const dedicatedSecret = env.HASURA_JWT_SECRET || '';
  const fallbackSecret = env.JWT_SECRET || '';

  return {
    tokenSecret: dedicatedSecret || fallbackSecret,
    tokenSecretSource: dedicatedSecret
      ? 'HASURA_JWT_SECRET' as const
      : fallbackSecret
        ? 'JWT_SECRET' as const
        : 'missing' as const,
    tokenTtlSeconds,
    hasuraPublicUrl: env.HASURA_PUBLIC_URL || '',
    apiBaseUrl: env.API_BASE_URL || '',
  };
}

export function resolveFunctionsConfig(env: NodeJS.ProcessEnv = process.env) {
  const internalTokenSecret = env.FUNCTIONS_INTERNAL_TOKEN_SECRET || env.JWT_SECRET || '';
  const workerSecret = env.DENO_WORKER_SECRET || internalTokenSecret;
  if (new TextEncoder().encode(workerSecret).byteLength < 32) {
    throw new Error('DENO_WORKER_SECRET must contain at least 32 UTF-8 bytes');
  }

  return {
    internalTokenSecret,
    internalTokenTtlSeconds: parseInt(env.FUNCTIONS_INTERNAL_TOKEN_TTL_SECONDS || '300', 10),
    workerSecret,
  };
}

export function resolveAccountDeletionConfig(env: NodeJS.ProcessEnv = process.env) {
  const statusSecret = env.ACCOUNT_DELETION_STATUS_SECRET || '';
  const fenceSecret = env.ACCOUNT_DELETION_FENCE_SECRET || '';
  const executorEnabled = parseBooleanEnv(env.ACCOUNT_DELETION_EXECUTOR_ENABLED, true);
  const production = (env.NODE_ENV || 'development') === 'production';

  if (production) {
    if (Buffer.byteLength(statusSecret, 'utf8') < 32) {
      throw new Error('ACCOUNT_DELETION_STATUS_SECRET must contain at least 32 UTF-8 bytes in production');
    }
    if (Buffer.byteLength(fenceSecret, 'utf8') < 32) {
      throw new Error('ACCOUNT_DELETION_FENCE_SECRET must contain at least 32 UTF-8 bytes in production');
    }
    const protectedSecrets = [
      env.JWT_SECRET,
      env.PROJECT_AUTH_JWT_SECRET,
      env.HASURA_JWT_SECRET,
      env.FUNCTIONS_INTERNAL_TOKEN_SECRET,
      env.DENO_WORKER_SECRET,
      env.STORAGE_TRUSTED_TICKET_SECRET,
    ].filter((value): value is string => Boolean(value));
    if (statusSecret === fenceSecret || protectedSecrets.includes(statusSecret) || protectedSecrets.includes(fenceSecret)) {
      throw new Error('Account deletion secrets must be distinct from each other and other signing secrets');
    }
  }

  return {
    statusSecret,
    fenceSecret,
    executorEnabled,
    intentTtlSeconds: Math.max(60, parseInt(env.ACCOUNT_DELETION_INTENT_TTL_SECONDS || '600', 10)),
    reauthMaxAgeSeconds: Math.max(60, parseInt(env.ACCOUNT_DELETION_REAUTH_MAX_AGE_SECONDS || '300', 10)),
    executorPollMs: Math.max(1_000, parseInt(env.ACCOUNT_DELETION_EXECUTOR_POLL_MS || '5000', 10)),
    executorLeaseSeconds: Math.max(30, parseInt(env.ACCOUNT_DELETION_EXECUTOR_LEASE_SECONDS || '120', 10)),
    cleanupStatementTimeoutMs: Math.max(1_000, parseInt(env.ACCOUNT_DELETION_CLEANUP_TIMEOUT_MS || '30000', 10)),
  };
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxy: parseBooleanEnv(process.env.TRUST_PROXY, false),
  corsOrigins: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) || [],
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || '',
    database: process.env.DB_NAME || 'druvia',
  },
  jwt: {
    secret: process.env.JWT_SECRET || '',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  hasura: {
    adminSecret: process.env.HASURA_ADMIN_SECRET || '',
    endpoint: process.env.HASURA_ENDPOINT || 'http://localhost:8080',
  },
  realtime: resolveRealtimeConfig(),
  functions: resolveFunctionsConfig(),
  projectAuth: {
    tokenSecret: process.env.PROJECT_AUTH_JWT_SECRET || process.env.JWT_SECRET || '',
    defaultAccessTokenTtlSeconds: parseInt(process.env.PROJECT_AUTH_ACCESS_TOKEN_TTL_SECONDS || '3600', 10),
  },
  accountDeletion: resolveAccountDeletionConfig(),
  storage: {
    trustedTicketSecret: process.env.STORAGE_TRUSTED_TICKET_SECRET || '',
    trustedTicketMaxTtlSeconds: parseInt(process.env.STORAGE_TRUSTED_TICKET_MAX_TTL_SECONDS || '900', 10),
  },
  updater: {
    url: process.env.DRUVIA_UPDATER_URL || '',
    secret: process.env.DRUVIA_UPDATER_SECRET || '',
  },
  version: process.env.DRUVIA_VERSION || process.env.npm_package_version || '0.1.0',
};
