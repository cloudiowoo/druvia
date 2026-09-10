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

  it('documents GHCR and self-hosted registry OTA manifest choices', () => {
    const releaseEnv = read('docker/.env.release.example');

    expect(releaseEnv).toContain('DRUVIA_RELEASE_MANIFEST_URL=https://github.com/druvia/druvia/releases/latest/download/release-manifest.json');
    expect(releaseEnv).toContain('# For self-hosted registry images, use release-manifest.cn.json instead:');
    expect(releaseEnv).toContain('# DRUVIA_RELEASE_MANIFEST_URL=https://github.com/druvia/druvia/releases/latest/download/release-manifest.cn.json');
    expect(releaseEnv).toContain('# DRUVIA_API_IMAGE=druvia.forestpartner.com/druvia/druvia-api:0.1.0');
    expect(releaseEnv).toContain('# DRUVIA_ADMIN_IMAGE=druvia.forestpartner.com/druvia/druvia-admin:0.1.0');
    expect(releaseEnv).toContain('# DRUVIA_WORKER_IMAGE=druvia.forestpartner.com/druvia/druvia-worker:0.1.0');
    expect(releaseEnv).toContain('# DRUVIA_UPDATER_IMAGE=druvia.forestpartner.com/druvia/druvia-updater:0.1.0');
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

  it('keeps local storage data outside source application directories', () => {
    const releaseCompose = read('docker/docker-compose.release.yml');
    const prodCompose = read('docker/docker-compose.prod.yml');
    const localCompose = read('docker/docker-compose.local.yml');
    const prodEnv = read('docker/.env.prod.example');
    const localEnv = read('docker/.env.example');
    const dockerGitignore = read('docker/.gitignore');

    expect(releaseCompose).toContain('${STORAGE_HOST_PATH:-./storage_data}:/app/data/storage');
    expect(prodCompose).toContain('${STORAGE_HOST_PATH:-./storage_data}:/app/data/storage');
    expect(localCompose).toContain('${STORAGE_HOST_PATH:-./storage_data}:/app/data/storage');
    expect(prodEnv).toContain('STORAGE_HOST_PATH=./storage_data');
    expect(localEnv).toContain('STORAGE_HOST_PATH=./storage_data');
    expect(dockerGitignore).toContain('storage_data/');

    expect(releaseCompose).not.toContain('../apps/api/data/storage');
    expect(prodCompose).not.toContain('../apps/api/data/storage');
    expect(localCompose).not.toContain('../apps/api/data/storage');
    expect(prodEnv).not.toContain('../apps/api/data/storage');
    expect(localEnv).not.toContain('../apps/api/data/storage');
  });

  it('runs the account deletion executor inside API in local, production and release modes', () => {
    for (const path of [
      'docker/docker-compose.local.yml',
      'docker/docker-compose.prod.yml',
      'docker/docker-compose.release.yml',
    ]) {
      const compose = read(path);
      expect(compose).toContain('ACCOUNT_DELETION_STATUS_SECRET: ${ACCOUNT_DELETION_STATUS_SECRET:-}');
      expect(compose).toContain('ACCOUNT_DELETION_FENCE_SECRET: ${ACCOUNT_DELETION_FENCE_SECRET:-}');
      expect(compose).toContain('ACCOUNT_DELETION_EXECUTOR_ENABLED: ${ACCOUNT_DELETION_EXECUTOR_ENABLED:-true}');
      expect(compose).not.toContain('account-deletion-executor:');
    }
  });

  it('mounts migrations into the local API so the packaged CLI can run', () => {
    const compose = read('docker/docker-compose.local.yml');

    expect(compose).toContain('../migrations:/app/migrations:ro');
  });

  it('renews production certificates against the active release deployment when available', () => {
    const renewScript = read('docker/certbot/renew-prod-certs.sh');

    expect(renewScript).toContain('docker-compose.release.yml');
    expect(renewScript).toContain('docker-compose.prod.yml');
    expect(renewScript).toContain('.env.release');
    expect(renewScript).toContain('DRUVIA_DEPLOY_DIR');
    expect(renewScript).toContain('docker compose "$@" -f "${COMPOSE_FILE}" --profile with-nginx run --rm certbot renew');
    expect(renewScript).toContain('docker compose "$@" -f "${COMPOSE_FILE}" --profile with-nginx exec -T nginx nginx -s reload');
  });

  it('provides a standalone registry compose for production-reachable image hosting', () => {
    const registryCompose = read('docker/registry/docker-compose.yml');
    const registryEnv = read('docker/registry/.env.example');
    const registryGitignore = read('docker/registry/.gitignore');
    const dockerGitignore = read('docker/.gitignore');

    expect(registryCompose).toContain('name: druvia-registry');
    expect(registryCompose).toContain('image: registry:2');
    expect(registryCompose).toContain('container_name: druvia-registry');
    expect(registryCompose).toContain('"${REGISTRY_BIND_ADDR:-127.0.0.1}:${REGISTRY_PORT:-5000}:5000"');
    expect(registryCompose).toContain('REGISTRY_HTTP_ADDR: 0.0.0.0:5000');
    expect(registryCompose).toContain('REGISTRY_HTTP_SECRET: ${REGISTRY_HTTP_SECRET:?Set REGISTRY_HTTP_SECRET in .env}');
    expect(registryCompose).toContain('REGISTRY_AUTH: htpasswd');
    expect(registryCompose).toContain('REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd');
    expect(registryCompose).toContain('REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry');
    expect(registryCompose).toContain('./registry_data:/var/lib/registry');
    expect(registryCompose).toContain('./registry_auth:/auth:ro');
    expect(registryCompose).not.toContain('druvia-network');
    expect(registryCompose).not.toContain('depends_on:');
    expect(registryCompose).not.toContain('docker-compose.release.yml');
    expect(registryCompose).not.toContain('.env.release');

    expect(registryEnv).toContain('REGISTRY_BIND_ADDR=127.0.0.1');
    expect(registryEnv).toContain('REGISTRY_PORT=5000');
    expect(registryEnv).toContain('REGISTRY_HTTP_SECRET=');

    expect(registryGitignore).toContain('registry_data/*');
    expect(registryGitignore).toContain('registry_auth/*');
    expect(registryGitignore).toContain('.env');
    expect(dockerGitignore).not.toContain('registry_data/');
    expect(dockerGitignore).not.toContain('registry_auth/*');
  });
});
