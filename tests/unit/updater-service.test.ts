import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUpdaterConfig } from '../../apps/updater/src/config.js';
import {
  UpdateOperationInProgressError,
  UpdatePreconditionError,
  UpdateService,
} from '../../apps/updater/src/update-service.js';
import { writeUpdateState } from '../../apps/updater/src/state.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

async function createConfigRoot() {
  const root = await mkdtemp(join(tmpdir(), 'druvia-updater-'));
  const deployDir = join(root, 'deploy');
  const stateDir = join(root, 'state');
  const releaseEnvPath = join(deployDir, '.env.release');
  const composePath = join(deployDir, 'docker-compose.release.yml');
  await mkdir(deployDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const config = parseUpdaterConfig({
    DRUVIA_UPDATER_SECRET: 'secret',
    DRUVIA_CURRENT_VERSION: '0.1.0',
    DRUVIA_UPDATE_CHANNEL: 'stable',
    DRUVIA_RELEASE_MANIFEST_URL: 'https://github.com/druvia/druvia/releases/latest/download/release-manifest.json',
    DRUVIA_RELEASE_ALLOWED_HOSTS: 'github.com',
    DRUVIA_DEPLOY_DIR: deployDir,
    DRUVIA_STATE_DIR: stateDir,
    DRUVIA_BASE_ENV_FILE: join(deployDir, '.env.prod'),
    DRUVIA_RELEASE_ENV_FILE: releaseEnvPath,
    DRUVIA_COMPOSE_FILE: composePath,
    DRUVIA_MANAGED_SERVICES: 'api,admin,deno,hasura',
    POSTGRES_PASSWORD: 'postgres-password',
  });

  return { root, deployDir, stateDir, releaseEnvPath, composePath, config };
}

function buildManifest(composeContent: string) {
  return {
    schemaVersion: 1,
    product: 'druvia',
    version: '0.2.0',
    channel: 'stable',
    createdAt: '2026-07-28T00:00:00.000Z',
    minUpdaterVersion: '0.1.0',
    releaseNotesUrl: 'https://github.com/druvia/druvia/releases/tag/v0.2.0',
    compose: {
      url: 'https://github.com/druvia/druvia/releases/download/v0.2.0/docker-compose.release.yml',
      sha256: createHash('sha256').update(composeContent).digest('hex'),
    },
    images: {
      api: { repository: 'ghcr.io/druvia/druvia-api', tag: '0.2.0', digest: digest('a') },
      admin: { repository: 'ghcr.io/druvia/druvia-admin', tag: '0.2.0', digest: digest('b') },
      worker: { repository: 'ghcr.io/druvia/druvia-worker', tag: '0.2.0', digest: digest('c') },
      updater: { repository: 'ghcr.io/druvia/druvia-updater', tag: '0.2.0', digest: digest('d') },
    },
    migrations: {
      required: true,
      from: 17,
      to: 18,
      requiresBackup: false,
      reversible: false,
    },
  };
}

async function writeReadyToApplyState(
  config: ReturnType<typeof parseUpdaterConfig>,
  manifest: ReturnType<typeof buildManifest>
) {
  await writeUpdateState(config.statePath, {
    enabled: true,
    phase: 'ready_to_apply',
    currentVersion: '0.1.0',
    availableVersion: manifest.version,
    channel: 'stable',
    releaseNotesUrl: manifest.releaseNotesUrl,
    migration: manifest.migrations,
    operationId: null,
    startedAt: null,
    finishedAt: null,
    message: `Version ${manifest.version} is ready to apply`,
    error: null,
  });
}

describe('updater service', () => {
  it('rejects a second mutating operation while one is running', async () => {
    const { config } = await createConfigRoot();
    const service = new UpdateService(config, {
      backgroundRunner: () => undefined,
      operationIdFactory: () => 'op-locked',
    });

    const accepted = await service.restartServices();
    expect(accepted.operationId).toBe('op-locked');
    await expect(service.downloadUpdate()).rejects.toBeInstanceOf(UpdateOperationInProgressError);
  });

  it('downloads images by digest and stages compose plus release env without dropping existing updater settings', async () => {
    const { config, deployDir, releaseEnvPath } = await createConfigRoot();
    const composeContent = 'services:\n  api:\n    image: ${DRUVIA_API_IMAGE}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, [
      'DRUVIA_VERSION=0.1.0',
      'DRUVIA_UPDATER_SECRET=secret',
      'DRUVIA_MANAGED_SERVICES=api,admin,deno,hasura',
      'DRUVIA_API_IMAGE=ghcr.io/druvia/druvia-api:0.1.0',
      '',
    ].join('\n'), 'utf8');

    const commands: Array<{ command: string; args: string[] }> = [];
    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('release-manifest.json')) return new Response(JSON.stringify(manifest));
        if (url.endsWith('docker-compose.release.yml')) return new Response(composeContent);
        throw new Error(`Unexpected fetch: ${url}`);
      },
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-download',
    });

    const accepted = await service.downloadUpdate();
    await Promise.all(backgroundTasks);

    expect(accepted.operationId).toBe('op-download');
    expect(commands.map((item) => item.args.join(' '))).toEqual([
      `image pull ghcr.io/druvia/druvia-api@${digest('a')}`,
      `image pull ghcr.io/druvia/druvia-admin@${digest('b')}`,
      `image pull ghcr.io/druvia/druvia-worker@${digest('c')}`,
      `image pull ghcr.io/druvia/druvia-updater@${digest('d')}`,
    ]);
    await expect(readFile(join(deployDir, 'docker-compose.release.yml.staged'), 'utf8')).resolves.toBe(composeContent);
    const stagedEnv = await readFile(join(deployDir, '.env.release.staged'), 'utf8');
    expect(stagedEnv).toContain('DRUVIA_UPDATER_SECRET=secret');
    expect(stagedEnv).toContain(`DRUVIA_API_IMAGE=ghcr.io/druvia/druvia-api@${digest('a')}`);
    expect(stagedEnv).toContain(`DRUVIA_ADMIN_IMAGE=ghcr.io/druvia/druvia-admin@${digest('b')}`);
    expect(stagedEnv).toContain('DRUVIA_VERSION=0.2.0');
    const status = await service.getStatus();
    expect(status.phase).toBe('ready_to_apply');
    expect(status.operationId).toBeNull();
    expect(status.finishedAt).not.toBeNull();
  });

  it('compares manifests against the persisted current version after a previous successful update', async () => {
    const { config } = await createConfigRoot();
    const manifest = buildManifest('services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true,
      phase: 'succeeded',
      currentVersion: '0.2.0',
      availableVersion: null,
      channel: 'stable',
      releaseNotesUrl: null,
      migration: null,
      operationId: null,
      startedAt: null,
      finishedAt: null,
      message: null,
      error: null,
    });

    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response(JSON.stringify(manifest)),
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-check',
    });

    await service.checkForUpdates();
    await Promise.all(backgroundTasks);

    const status = await service.getStatus();
    expect(status.phase).toBe('idle');
    expect(status.message).toBe('Current version is up to date');
    expect(status.operationId).toBeNull();
    expect(status.finishedAt).not.toBeNull();
  });

  it('checks for an update without marking release files as staged for apply', async () => {
    const { config } = await createConfigRoot();
    const manifest = buildManifest('services: {}\n');

    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response(JSON.stringify(manifest)),
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-check',
    });

    await service.checkForUpdates();
    await Promise.all(backgroundTasks);

    const status = await service.getStatus();
    expect(status.phase).toBe('available');
    expect(status.operationId).toBeNull();
    expect(status.finishedAt).not.toBeNull();
    await expect(access(config.stagedManifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts apply before touching the active release env when the required database backup fails', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    manifest.migrations.requiresBackup = true;
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);

    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async (command) => {
        if (command === 'pg_dump') throw new Error('pg_dump failed');
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-apply-failed',
    });

    await service.applyUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.error?.message).toContain('pg_dump failed');
  });

  it('fails apply before touching release files when pg_dump exits without creating a dump', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    manifest.migrations.requiresBackup = true;
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);

    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async () => ({ stdout: '', stderr: '' }),
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-missing-dump',
    });

    await service.applyUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.error?.message).toContain('postgres.dump');
  });

  it('automatically restores the previous release files and restarts managed services when apply fails after switching files', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const oldCompose = 'services:\n  api:\n    image: old\n';
    const newCompose = 'services:\n  api:\n    image: new\n';
    const manifest = buildManifest(newCompose);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, oldCompose, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(config.stagedComposePath, newCompose, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);

    const commands: Array<{ command: string; args: string[] }> = [];
    const backgroundTasks: Promise<void>[] = [];
    let composeUpFailures = 0;
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok', { status: 200 }),
      runCommand: async (command, args) => {
        commands.push({ command, args });
        if (args.includes('up') && args.includes('--remove-orphans') && composeUpFailures === 0) {
          composeUpFailures += 1;
          throw new Error('compose up failed');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-apply-rollback',
    });

    await service.applyUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
    await expect(readFile(composePath, 'utf8')).resolves.toBe(oldCompose);
    expect(commands.map((item) => item.args.join(' '))).toEqual([
      'compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' run --rm api node apps/api/dist/cli/migrate.js up',
      'compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' up -d --remove-orphans api admin deno hasura',
      'compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' up -d --remove-orphans api admin deno hasura',
    ]);
    const status = await service.getStatus();
    expect(status.phase).toBe('rolled_back');
    expect(status.error?.message).toContain('compose up failed');
    expect(status.message).toContain('Rolled back');
  });

  it('rejects apply when no downloaded update is ready even if stale staged files exist', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true,
      phase: 'available',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      channel: 'stable',
      releaseNotesUrl: manifest.releaseNotesUrl,
      migration: manifest.migrations,
      operationId: null,
      startedAt: null,
      finishedAt: null,
      message: 'Version 0.2.0 is available',
      error: null,
    });

    const service = new UpdateService(config, {
      operationIdFactory: () => 'op-stale-apply',
    });

    await expect(service.applyUpdate()).rejects.toBeInstanceOf(UpdatePreconditionError);
    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
  });

  it('applies staged release files, runs migration and brings managed services up before marking success', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(config.stagedComposePath, 'services:\n  api: {}\n', 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);

    const commands: Array<{ command: string; args: string[] }> = [];
    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok', { status: 200 }),
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-apply',
    });

    await service.applyUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.2.0\n');
    expect(commands.slice(0, 2).map((item) => `${item.command} ${item.args.join(' ')}`)).toEqual([
      'docker compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' run --rm api node apps/api/dist/cli/migrate.js up',
      'docker compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' up -d --remove-orphans api admin deno hasura',
    ]);
    const finalizerCommand = commands[2];
    expect(finalizerCommand?.command).toBe('docker');
    expect(finalizerCommand?.args.slice(0, 5)).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'druvia-updater-finalizer-op-apply',
    ]);
    expect(finalizerCommand?.args).toContain(`ghcr.io/druvia/druvia-updater@${digest('d')}`);
    expect(finalizerCommand?.args).toContain('--volumes-from');
    expect(finalizerCommand?.args).toContain('druvia-updater:rw');
    expect(finalizerCommand?.args).toContain('DRUVIA_FINALIZER_TARGET_VERSION=0.2.0');
    expect(finalizerCommand?.args.join(' ')).toContain('up -d updater');
    const status = await service.getStatus();
    expect(status.phase).toBe('finalizing');
    expect(status.currentVersion).toBe('0.2.0');
    expect(status.message).toBe('Updated to 0.2.0; updater finalizer scheduled');
  });

  it('rolls back active release files from the failed operation backup and restarts managed services', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-failed');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(composePath, 'services:\n  api: {}\n', 'utf8');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true,
      phase: 'failed',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      channel: 'stable',
      releaseNotesUrl: null,
      migration: null,
      operationId: 'op-failed',
      startedAt: null,
      finishedAt: null,
      message: 'apply failed',
      error: { code: 'UPDATE_OPERATION_FAILED', message: 'apply failed' },
    });

    const commands: Array<{ command: string; args: string[] }> = [];
    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok', { status: 200 }),
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-rollback',
    });

    await service.rollbackUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
    expect(commands.map((item) => item.args.join(' '))).toEqual([
      'compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' up -d --remove-orphans api admin deno hasura',
    ]);
    const status = await service.getStatus();
    expect(status.phase).toBe('rolled_back');
    expect(status.operationId).toBeNull();
  });

  it('preserves the failed apply operation id when manual rollback fails so it can be retried', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-failed');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(composePath, 'services:\n  api: {}\n', 'utf8');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true,
      phase: 'failed',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      channel: 'stable',
      releaseNotesUrl: null,
      migration: null,
      operationId: 'op-failed',
      startedAt: null,
      finishedAt: null,
      message: 'apply failed',
      error: { code: 'UPDATE_OPERATION_FAILED', message: 'apply failed' },
    });

    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async () => {
        throw new Error('rollback compose failed');
      },
      backgroundRunner: (task) => {
        backgroundTasks.push(task());
      },
      operationIdFactory: () => 'op-rollback',
    });

    await service.rollbackUpdate();
    await Promise.all(backgroundTasks);

    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.operationId).toBe('op-failed');
    expect(status.error?.message).toContain('rollback compose failed');
  });
});
