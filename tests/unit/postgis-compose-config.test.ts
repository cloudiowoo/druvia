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

function renderDualDatabaseCompose(target: 'postgres' | 'postgres-postgis'): Record<string, any> {
  const output = execFileSync('docker', [
    'compose',
    '-f',
    'docker/docker-compose.local.yml',
    '-f',
    'docker/docker-compose.local.dual-db.yml',
    '--profile',
    'postgis-tools',
    'config',
    '--format',
    'json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...composeEnv,
      DRUVIA_LOCAL_DB_HOST: target,
      POSTGRES_POSTGIS_PORT: '5632',
    },
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

  it.each(['postgres', 'postgres-postgis'] as const)(
    'renders local dual databases with %s selected',
    (target) => {
      const rendered = renderDualDatabaseCompose(target);
      const plain = rendered.services.postgres;
      const postgis = rendered.services['postgres-postgis'];

      expect(plain.image).toBe('postgres:17-alpine');
      expect(plain.volumes).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: expect.stringMatching(/postgres_data$/) }),
      ]));
      expect(postgis.image).toBe('postgis/postgis:17-3.5-alpine');
      expect(postgis.platform).toBe('linux/amd64');
      expect(postgis.volumes).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: expect.stringMatching(/postgres_postgis_data$/) }),
      ]));
      expect(rendered.services.api.environment.DB_HOST).toBe(target);
      expect(rendered.services.hasura.environment.HASURA_GRAPHQL_DATABASE_URL).toContain(
        `@${target}:5432/druvia`
      );
      expect(rendered.services.api.depends_on['postgres-postgis']).toBeUndefined();
      expect(rendered.services.hasura.depends_on['postgres-postgis']).toBeUndefined();
      expect(rendered.services['postgis-enable'].command).toContain('postgres-postgis');
    }
  );

  it('documents local database target selection and ignores both data directories', () => {
    const localEnv = read('docker/.env.example');
    const dockerIgnore = read('docker/.gitignore');

    expect(localEnv).toContain('DRUVIA_LOCAL_DB_HOST=postgres');
    expect(localEnv).toContain('POSTGRES_POSTGIS_PORT=5632');
    expect(dockerIgnore).toContain('postgres_data/');
    expect(dockerIgnore).toContain('postgres_postgis_data/');
  });

  it('documents deterministic PostGIS initialization before target switching', () => {
    const playbook = read('docs/agent/playbooks.md');

    expect(playbook).toContain('druvia_local_plain_before_postgis');
    expect(playbook).toContain('druvia_local_postgis_before_reset');
    expect(playbook).toContain('export_metadata');
    expect(playbook).toContain('up -d postgres postgres-postgis redis api hasura');
    expect(playbook).toContain('select(has("event_triggers"))');
    expect(playbook).toContain("n.nspname = 'hdb_catalog'");
    expect(playbook).toContain('-N hdb_catalog');
    expect(playbook).toContain('= "$(pwd)/postgres_postgis_data"');
    expect(playbook).toContain('pg_restore -U postgres -d druvia');
    expect(playbook).toContain('stop api admin hasura deno');
    expect(playbook).toContain('--profile postgis-tools');
    expect(playbook).toContain('POSTGIS_HOST_PORT="$(docker inspect druvia-postgres-postgis');
    expect(playbook).toContain('DB_PORT="$POSTGIS_HOST_PORT" pnpm migrate up');
    expect(playbook).toContain('replace_metadata');
    expect(playbook).toContain('get_inconsistent_metadata');

    const initialUp = playbook.indexOf('up -d postgres postgres-postgis redis api hasura');
    const initialWait = playbook.indexOf('HASURA_READY=0', initialUp);
    const metadataExport = playbook.indexOf('export_metadata', initialWait);
    expect(initialUp).toBeGreaterThanOrEqual(0);
    expect(initialWait).toBeGreaterThan(initialUp);
    expect(metadataExport).toBeGreaterThan(initialWait);

    expect(playbook).toContain('stop api admin hasura deno');
    expect(playbook).toContain('up -d --no-deps --force-recreate hasura');
    expect(playbook).toContain('up -d --no-deps --force-recreate api');
    expect(playbook).toContain('up -d --no-deps --force-recreate admin deno');

    expect(playbook).toContain('up -d postgres postgres-postgis redis');
    expect(playbook).toContain('druvia-local-switch-metadata.json');
    expect(playbook).toContain('EXPECTED_MIGRATIONS=');
    expect(playbook).toContain('APPLIED_MIGRATIONS=');
    expect(playbook).toContain("string_agg(version::text, ',' ORDER BY version)");
    expect(playbook).toContain("-c 'SELECT 1;'");
    expect(playbook).toContain('重置失败时恢复原 PostGIS');
    expect(playbook).toContain('POSTGIS_BACKUP="/absolute/path/to/');
    expect(playbook).toContain('METADATA_BACKUP="/absolute/path/to/');
    expect(playbook).toContain('< "$POSTGIS_BACKUP"');

    const writerStop = playbook.indexOf('stop api admin deno');
    const metadataExportAfterStop = playbook.indexOf('export_metadata', writerStop);
    const plainDump = playbook.indexOf('pg_dump -U postgres -d druvia');
    expect(writerStop).toBeGreaterThanOrEqual(0);
    expect(metadataExportAfterStop).toBeGreaterThan(writerStop);
    expect(plainDump).toBeGreaterThan(writerStop);
  });

  it('keeps daily dual-database operations ahead of low-frequency recovery details', () => {
    const playbook = read('docs/agent/playbooks.md');
    const quickReference = playbook.indexOf('#### 日常速查（重点）');
    const initialization = playbook.indexOf('首次初始化或重置 PostGIS（低频操作）');
    const detailsOpen = playbook.match(/<details>/g)?.length ?? 0;
    const detailsClose = playbook.match(/<\/details>/g)?.length ?? 0;

    expect(quickReference).toBeGreaterThanOrEqual(0);
    expect(initialization).toBeGreaterThan(quickReference);
    expect(detailsOpen).toBe(2);
    expect(detailsClose).toBe(detailsOpen);
  });

  it('documents executable guards before stopping the parallel PostGIS service', () => {
    const playbook = read('docs/agent/playbooks.md');
    const stopSection = playbook.indexOf('#### 停止 PostGIS 并保留数据');
    const apiGuard = playbook.indexOf("sed -n 's/^DB_HOST=//p')\" = \"postgres\"", stopSection);
    const hasuraGuard = playbook.indexOf('HASURA_GRAPHQL_DATABASE_URL=.*@\\([^:]*\\):5432/druvia', stopSection);
    const stopPostgis = playbook.indexOf('stop postgres-postgis', stopSection);

    expect(stopSection).toBeGreaterThanOrEqual(0);
    expect(apiGuard).toBeGreaterThan(stopSection);
    expect(hasuraGuard).toBeGreaterThan(stopSection);
    expect(stopPostgis).toBeGreaterThan(hasuraGuard);
  });
});
