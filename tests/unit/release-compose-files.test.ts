import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('release-mode compose and Dockerfiles', () => {
  it('uses release image variables instead of local builds for application services', () => {
    const compose = read('docker/docker-compose.release.yml');

    expect(compose).toContain('image: ${DRUVIA_API_IMAGE}');
    expect(compose).toContain('image: ${DRUVIA_ADMIN_IMAGE}');
    expect(compose).toContain('image: ${DRUVIA_WORKER_IMAGE}');
    expect(compose).not.toMatch(/\n  api:\n(?:.*\n){0,12}    build:/);
    expect(compose).not.toMatch(/\n  admin:\n(?:.*\n){0,12}    build:/);
    expect(compose).not.toContain('./deno-worker:/app:ro');
  });

  it('keeps updater internal and gives it the required controlled mounts', () => {
    const compose = read('docker/docker-compose.release.yml');
    const updaterBlock = compose.slice(compose.indexOf('  updater:'), compose.indexOf('  loki:'));

    expect(updaterBlock).toContain('image: ${DRUVIA_UPDATER_IMAGE}');
    expect(updaterBlock).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(updaterBlock).toContain('DRUVIA_DEPLOY_DIR: ${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}');
    expect(updaterBlock).toContain('"${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}:${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}"');
    expect(updaterBlock).toContain('update_state:/state');
    expect(updaterBlock).toContain('DRUVIA_MANAGED_SERVICES: ${DRUVIA_MANAGED_SERVICES:-api,admin,deno,hasura}');
    expect(updaterBlock).toContain('DRUVIA_UPDATER_CONTAINER_NAME: ${DRUVIA_UPDATER_CONTAINER_NAME:-druvia-updater}');
    expect(updaterBlock).not.toContain('ports:');
    expect(updaterBlock).not.toContain('./:/deploy');
  });

  it('ships migrations and updater dependencies in production Dockerfiles', () => {
    expect(read('docker/Dockerfile.api')).toContain('COPY --from=builder /app/migrations ./migrations');
    expect(read('docker/Dockerfile.worker')).toContain('COPY *.ts ./');
    expect(read('docker/Dockerfile.updater')).toContain('docker-cli docker-cli-compose postgresql-client wget');
  });

  it('builds the admin image with the shared workspace package it imports', () => {
    const adminDockerfile = read('docker/Dockerfile.admin');

    expect(adminDockerfile).toContain('COPY packages/shared/package.json ./packages/shared/');
    expect(adminDockerfile).toContain('COPY packages/shared ./packages/shared');
    expect(adminDockerfile).toContain('RUN pnpm --filter @druvia/shared build');
  });

  it('documents an absolute host deploy directory for docker-socket compose operations', () => {
    const releaseEnv = read('docker/.env.release.example');

    expect(releaseEnv).toContain('DRUVIA_DEPLOY_DIR=/absolute/path/to/Druvia/docker');
    expect(releaseEnv).toContain('DRUVIA_BASE_ENV_FILE=');
    expect(releaseEnv).not.toContain('DRUVIA_DEPLOY_DIR=/deploy');
    expect(releaseEnv).not.toContain('DRUVIA_BASE_ENV_FILE=/deploy/.env.prod');
  });

  it('provides a local nginx profile for same-origin OTA testing', () => {
    const compose = read('docker/docker-compose.release.yml');
    const start = compose.indexOf('  local-nginx:');
    const end = compose.indexOf('\nvolumes:', start);
    const localNginxBlock = compose.slice(start, end);

    expect(localNginxBlock).toContain('container_name: druvia-local-nginx');
    expect(localNginxBlock).toContain('- "${LOCAL_HTTP_PORT:-8088}:80"');
    expect(localNginxBlock).toContain('- ./nginx/conf.d.local:/etc/nginx/conf.d:ro');
    expect(localNginxBlock).toContain('- with-local-nginx');
    expect(localNginxBlock).not.toContain('./nginx/ssl:/etc/nginx/ssl:ro');
    expect(localNginxBlock).not.toContain('certbot:');
  });
});
