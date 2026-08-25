import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const composeEnv = {
  ...process.env,
  API_BASE_URL: 'http://localhost:3001',
  CERTBOT_EMAIL: 'admin@example.com',
  CERTBOT_PRIMARY_DOMAIN: 'example.com',
  DENO_WORKER_SECRET: 'worker-secret-at-least-32-characters',
  DRUVIA_ADMIN_IMAGE: 'example/druvia-admin:test',
  DRUVIA_API_IMAGE: 'example/druvia-api:test',
  DRUVIA_DEPLOY_DIR: '/tmp/druvia-deploy',
  DRUVIA_POSTGRES_IMAGE: 'postgis/postgis:17-3.5-alpine',
  DRUVIA_POSTGRES_PLATFORM: 'linux/amd64',
  DRUVIA_RELEASE_MANIFEST_URL: 'https://example.com/release-manifest.json',
  DRUVIA_UPDATER_IMAGE: 'example/druvia-updater:test',
  DRUVIA_UPDATER_SECRET: 'updater-secret-at-least-32-characters',
  DRUVIA_VERSION: '0.0.0-test',
  DRUVIA_WORKER_IMAGE: 'example/druvia-worker:test',
  FUNCTIONS_INTERNAL_TOKEN_SECRET: 'function-secret-at-least-32-characters',
  HASURA_ADMIN_SECRET: 'hasura-admin-secret',
  HASURA_JWT_SECRET: 'hasura-jwt-secret-at-least-32-characters',
  JWT_SECRET: 'jwt-secret-at-least-32-characters',
  POSTGRES_PASSWORD: 'postgres-password',
  POSTGRES_PASSWORD_ENCODED: 'postgres-password',
  STORAGE_TRUSTED_TICKET_SECRET: 'storage-ticket-secret-at-least-32-chars',
};

function renderCompose(baseFile: string): Record<string, any> {
  const output = execFileSync('docker', [
    'compose',
    '-f',
    baseFile,
    '-f',
    'docker/docker-compose.postgis.yml',
    '--profile',
    'postgis-tools',
    'config',
    '--format',
    'json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: composeEnv,
  });

  return JSON.parse(output) as Record<string, any>;
}

describe('PostGIS Compose override', () => {
  it('overrides only PostgreSQL and provides an explicit extension task', () => {
    const compose = read('docker/docker-compose.postgis.yml');

    expect(compose).toContain('image: ${DRUVIA_POSTGRES_IMAGE:-postgis/postgis:17-3.5-alpine}');
    expect(compose).toContain('platform: ${DRUVIA_POSTGRES_PLATFORM:-linux/amd64}');
    expect(compose).toContain('  postgis-enable:');
    expect(compose).toContain('- postgis-tools');
    expect(compose).toContain('CREATE EXTENSION IF NOT EXISTS postgis;');
    expect(compose).toContain('condition: service_healthy');
    expect(compose).not.toContain('  api:');
    expect(compose).not.toContain('  admin:');
    expect(compose).not.toContain('  updater:');
    expect(compose).not.toContain('/var/lib/postgresql/data');
  });

  it.each([
    'docker/docker-compose.local.yml',
    'docker/docker-compose.prod.yml',
    'docker/docker-compose.release.yml',
  ])('renders a compatible PostgreSQL service with %s', (baseFile) => {
    const rendered = renderCompose(baseFile);
    const postgres = rendered.services.postgres;
    const extensionTask = rendered.services['postgis-enable'];

    expect(postgres.image).toBe('postgis/postgis:17-3.5-alpine');
    expect(postgres.platform).toBe('linux/amd64');
    expect(postgres.healthcheck.test).toContain('pg_isready -U postgres');
    expect(postgres.volumes).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: '/var/lib/postgresql/data' }),
    ]));
    expect(extensionTask.profiles).toContain('postgis-tools');
    expect(extensionTask.depends_on.postgres.condition).toBe('service_healthy');
    expect(extensionTask.command).toContain('CREATE EXTENSION IF NOT EXISTS postgis;');
  });

  it('documents manual database lifecycle and the OTA boundary', () => {
    const playbook = read('docs/agent/playbooks.md');
    const localEnv = read('docker/.env.example');
    const prodEnv = read('docker/.env.prod.example');

    expect(playbook).toContain('docker-compose.postgis.yml');
    expect(playbook).toContain('postgis-enable');
    expect(playbook).toContain('OTA 不管理 PostgreSQL/PostGIS 镜像');
    expect(localEnv).toContain('DRUVIA_POSTGRES_IMAGE=postgis/postgis:17-3.5-alpine');
    expect(localEnv).toContain('DRUVIA_POSTGRES_PLATFORM=linux/amd64');
    expect(prodEnv).toContain('DRUVIA_POSTGRES_IMAGE=postgis/postgis:17-3.5-alpine');
    expect(prodEnv).toContain('DRUVIA_POSTGRES_PLATFORM=linux/amd64');
  });
});
