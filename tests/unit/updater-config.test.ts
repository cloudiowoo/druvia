import { describe, expect, it } from 'vitest';
import { parseUpdaterConfig } from '../../apps/updater/src/config.js';

describe('updater config', () => {
  it('parses required updater env and release compose defaults', () => {
    const config = parseUpdaterConfig({
      DRUVIA_UPDATER_SECRET: 'secret-32-chars-secret-32-chars',
      DRUVIA_CURRENT_VERSION: '0.1.0',
      DRUVIA_UPDATE_CHANNEL: 'stable',
      DRUVIA_RELEASE_MANIFEST_URL: 'https://github.com/druvia/druvia/releases/latest/download/release-manifest.json',
      DRUVIA_RELEASE_ALLOWED_HOSTS: 'github.com, raw.githubusercontent.com',
      DRUVIA_DEPLOY_DIR: '/deploy',
      DRUVIA_STATE_DIR: '/state',
      DRUVIA_COMPOSE_PROFILES: 'with-nginx,with-logs',
      DRUVIA_MANAGED_SERVICES: 'api,admin,deno,hasura,nginx',
      POSTGRES_PASSWORD: 'postgres-password',
    });

    expect(config.currentVersion).toBe('0.1.0');
    expect(config.channel).toBe('stable');
    expect(config.allowedHosts).toEqual(['github.com', 'raw.githubusercontent.com']);
    expect(config.statePath).toBe('/state/update-state.json');
    expect(config.stagedManifestPath).toBe('/state/staged-manifest.json');
    expect(config.nextComposePath).toBe('/deploy/docker-compose.release.yml.next');
    expect(config.stagedComposePath).toBe('/deploy/docker-compose.release.yml.staged');
    expect(config.nextReleaseEnvPath).toBe('/deploy/.env.release.next');
    expect(config.stagedReleaseEnvPath).toBe('/deploy/.env.release.staged');
    expect(config.compose.profiles).toEqual(['with-nginx', 'with-logs']);
    expect(config.compose.managedServices).toEqual(['api', 'admin', 'deno', 'hasura', 'nginx']);
    expect(config.database.password).toBe('postgres-password');
  });

  it('fails startup when required updater env is missing', () => {
    expect(() => parseUpdaterConfig({
      DRUVIA_CURRENT_VERSION: '0.1.0',
      DRUVIA_RELEASE_MANIFEST_URL: 'https://github.com/druvia/druvia/releases/latest/download/release-manifest.json',
    })).toThrow(/DRUVIA_UPDATER_SECRET/);
  });
});
