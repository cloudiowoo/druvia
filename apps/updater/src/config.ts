import { join } from 'node:path';
import {
  DRUVIA_RELEASE_CHANNELS,
  type DruviaReleaseChannel,
} from '@druvia/shared';
import { parseCsvEnv, type ComposeOptions } from './compose.js';
import type { DatabaseConnectionConfig } from './postgres-backup.js';

const DEFAULT_ALLOWED_HOSTS = [
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
];

const DEFAULT_HEALTH_CHECK_URLS = [
  'http://api:3001/health',
  'http://admin:3000',
  'http://deno:7133/health',
  'http://hasura:8080/healthz',
];

export interface UpdaterConfig {
  updaterSecret: string;
  currentVersion: string;
  currentUpdaterVersion: string;
  channel: DruviaReleaseChannel;
  releaseManifestUrl: string;
  allowedHosts: string[];
  deployDir: string;
  stateDir: string;
  statePath: string;
  stagedManifestPath: string;
  nextComposePath: string;
  stagedComposePath: string;
  nextReleaseEnvPath: string;
  stagedReleaseEnvPath: string;
  compose: ComposeOptions;
  database: DatabaseConnectionConfig;
  healthCheckUrls: string[];
  healthCheckTimeoutMs: number;
  healthCheckIntervalMs: number;
  updaterContainerName: string;
  updaterFinalizerDelaySeconds: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required updater env: ${key}`);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseChannel(value: string | undefined): DruviaReleaseChannel {
  const channel = value || 'stable';
  if (!DRUVIA_RELEASE_CHANNELS.includes(channel as DruviaReleaseChannel)) {
    throw new Error(`Invalid update channel: ${channel}`);
  }
  return channel as DruviaReleaseChannel;
}

export function parseUpdaterConfig(env: NodeJS.ProcessEnv = process.env): UpdaterConfig {
  const updaterSecret = required(env, 'DRUVIA_UPDATER_SECRET');
  const currentVersion = required(env, 'DRUVIA_CURRENT_VERSION');
  const releaseManifestUrl = required(env, 'DRUVIA_RELEASE_MANIFEST_URL');
  const deployDir = env.DRUVIA_DEPLOY_DIR || '/deploy';
  const stateDir = env.DRUVIA_STATE_DIR || '/state';
  const baseEnvFile = env.DRUVIA_BASE_ENV_FILE || join(deployDir, '.env.prod');
  const releaseEnvFile = env.DRUVIA_RELEASE_ENV_FILE || join(deployDir, '.env.release');
  const composeFile = env.DRUVIA_COMPOSE_FILE || join(deployDir, 'docker-compose.release.yml');

  const allowedHosts = parseCsvEnv(env.DRUVIA_RELEASE_ALLOWED_HOSTS);
  const managedServices = parseCsvEnv(env.DRUVIA_MANAGED_SERVICES);

  return {
    updaterSecret,
    currentVersion,
    currentUpdaterVersion: env.DRUVIA_UPDATER_VERSION || '0.1.0',
    channel: parseChannel(env.DRUVIA_UPDATE_CHANNEL),
    releaseManifestUrl,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS,
    deployDir,
    stateDir,
    statePath: join(stateDir, 'update-state.json'),
    stagedManifestPath: join(stateDir, 'staged-manifest.json'),
    nextComposePath: join(deployDir, 'docker-compose.release.yml.next'),
    stagedComposePath: join(deployDir, 'docker-compose.release.yml.staged'),
    nextReleaseEnvPath: join(deployDir, '.env.release.next'),
    stagedReleaseEnvPath: join(deployDir, '.env.release.staged'),
    compose: {
      projectDirectory: deployDir,
      baseEnvFile,
      releaseEnvFile,
      composeFile,
      profiles: parseCsvEnv(env.DRUVIA_COMPOSE_PROFILES),
      managedServices: managedServices.length > 0 ? managedServices : ['api', 'admin', 'deno', 'hasura'],
    },
    database: {
      host: env.DB_HOST || 'postgres',
      port: parsePort(env.DB_PORT, 5432),
      user: env.DB_USER || 'postgres',
      password: env.POSTGRES_PASSWORD || '',
      database: env.DB_NAME || 'druvia',
    },
    healthCheckUrls: parseCsvEnv(env.DRUVIA_HEALTH_CHECK_URLS).length > 0
      ? parseCsvEnv(env.DRUVIA_HEALTH_CHECK_URLS)
      : DEFAULT_HEALTH_CHECK_URLS,
    healthCheckTimeoutMs: parsePositiveInteger(env.DRUVIA_HEALTH_CHECK_TIMEOUT_MS, 180_000),
    healthCheckIntervalMs: parsePositiveInteger(env.DRUVIA_HEALTH_CHECK_INTERVAL_MS, 2_000),
    updaterContainerName: env.DRUVIA_UPDATER_CONTAINER_NAME || 'druvia-updater',
    updaterFinalizerDelaySeconds: parsePositiveInteger(env.DRUVIA_UPDATER_FINALIZER_DELAY_SECONDS, 2),
  };
}
