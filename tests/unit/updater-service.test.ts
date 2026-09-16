import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseUpdaterConfig } from '../../apps/updater/src/config.js';
import { CommandError } from '../../apps/updater/src/command.js';
import {
  UpdateOperationInProgressError,
  UpdatePreconditionError,
  UpdateService,
} from '../../apps/updater/src/update-service.js';
import { writeUpdateState } from '../../apps/updater/src/state.js';
import { buildApp } from '../../apps/updater/src/index.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const openUnmocked = fs.open.bind(fs);

function buildStagedEnv(manifest: ReturnType<typeof buildManifest>): string {
  return [
    `DRUVIA_VERSION=${manifest.version}`,
    `DRUVIA_API_IMAGE=ghcr.io/druvia/druvia-api@${digest('a')}`,
    `DRUVIA_ADMIN_IMAGE=ghcr.io/druvia/druvia-admin@${digest('b')}`,
    `DRUVIA_WORKER_IMAGE=ghcr.io/druvia/druvia-worker@${digest('c')}`,
    `DRUVIA_UPDATER_IMAGE=ghcr.io/druvia/druvia-updater@${digest('d')}`,
    '',
  ].join('\n');
}

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
  it('recovers an interrupted apply even when one managed container no longer exists', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'verifying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-crash',
      applyStage: 'files_switched', startedAt: null, finishedAt: null, message: null, error: null,
    });
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        commands.push(args.join(' '));
        if (args[0] === 'stop' && args.includes('druvia-admin')) {
          throw new CommandError(command, args, 1, '', 'Error response from daemon: No such container: druvia-admin');
        }
        return { stdout: '', stderr: '' };
      },
    });
    await service.recoverInterruptedOperation();
    expect(commands.some((command) => command.endsWith('druvia-deno'))).toBe(true);
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('does not mask a real stop failure while retrying after a missing container', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'verifying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-crash',
      applyStage: 'files_switched', startedAt: null, finishedAt: null, message: null, error: null,
    });
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        commands.push(args.join(' '));
        if (args[0] === 'stop' && args.length > 4) {
          throw new CommandError(command, args, 1, '', 'Error response from daemon: No such container: druvia-admin');
        }
        if (args.at(-1) === 'druvia-admin') {
          throw new CommandError(command, args, 1, '', 'Error response from daemon: No such container: druvia-admin');
        }
        if (args.at(-1) === 'druvia-api') throw new Error('permission denied stopping live api');
        return { stdout: '', stderr: '' };
      },
    });
    await expect(service.recoverInterruptedOperation()).rejects.toThrow('permission denied stopping live api');
    expect(commands.some((command) => command.endsWith('druvia-deno'))).toBe(true);
    expect((await service.getStatus()).phase).toBe('verifying');
  });

  it('rejects a missing successful-apply backup without blocking subsequent updates', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'succeeded', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: null,
      lastAppliedBackup: { operationId: 'op-lost', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const service = new UpdateService(config, { backgroundRunner: () => undefined });
    await expect(service.rollbackUpdate()).rejects.toMatchObject({ code: 'UPDATE_BACKUP_NOT_AVAILABLE' });
    expect((await service.getStatus()).phase).toBe('succeeded');
    await expect(service.restartServices()).resolves.toMatchObject({ operationId: expect.any(String) });
  });

  it('does not publish ready_to_apply when a staged artifact cannot be synced', async () => {
    const { config, releaseEnvPath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === config.stagedReleaseEnvPath) throw new Error('staged env fsync unavailable');
      return openUnmocked(...args);
    });
    try {
      const tasks: Promise<void>[] = [];
      const service = new UpdateService(config, {
        fetch: async (input) => new Response(String(input).endsWith('release-manifest.json')
          ? JSON.stringify(manifest) : composeContent),
        runCommand: async () => ({ stdout: '', stderr: '' }),
        backgroundRunner: (task) => { tasks.push(task()); },
      });
      await service.downloadUpdate();
      await Promise.all(tasks);
      expect((await service.getStatus()).phase).toBe('failed');
    } finally {
      open.mockRestore();
    }
  });

  it('refuses to apply a staged Compose whose checksum differs from the admitted manifest', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const manifest = buildManifest('services: {}\n');
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, 'services: {}\n', 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
    await writeFile(config.stagedComposePath, 'services:\n  api: {}\n', 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async () => ({ stdout: '', stderr: '' }),
      backgroundRunner: (task) => { tasks.push(task()); },
    });
    await service.applyUpdate();
    await Promise.all(tasks);
    expect((await service.getStatus()).phase).toBe('failed');
    expect(await readFile(releaseEnvPath, 'utf8')).toBe('DRUVIA_VERSION=0.1.0\n');
  });

  it('refuses to apply staged images that differ from the admitted manifest', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest).replace(digest('a'), digest('e')), 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async () => ({ stdout: '', stderr: '' }),
      backgroundRunner: (task) => { tasks.push(task()); },
    });
    await service.applyUpdate();
    await Promise.all(tasks);
    expect((await service.getStatus()).phase).toBe('failed');
    expect(await readFile(releaseEnvPath, 'utf8')).toBe('DRUVIA_VERSION=0.1.0\n');
  });

  it('does not switch release files if the copied rollback backup cannot be synced', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === join(stateDir, 'backups', 'op-sync-backup', '.env.release')) {
        throw new Error('backup fsync unavailable');
      }
      return openUnmocked(...args);
    });
    try {
      const tasks: Promise<void>[] = [];
      const commands: string[] = [];
      const service = new UpdateService(config, {
        fetch: async () => new Response('ok'),
        runCommand: async (_command, args) => {
          commands.push(args.join(' '));
          return { stdout: '', stderr: '' };
        },
        backgroundRunner: (task) => { tasks.push(task()); },
        operationIdFactory: () => 'op-sync-backup',
      });
      await service.applyUpdate();
      await Promise.all(tasks);
      expect(commands).toEqual([]);
      expect(await readFile(releaseEnvPath, 'utf8')).toBe('DRUVIA_VERSION=0.1.0\n');
      expect((await service.getStatus()).phase).toBe('failed');
    } finally {
      open.mockRestore();
    }
  });

  it('does not reach finalizing when syncing switched release files fails', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);
    let failedOnce = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === releaseEnvPath && !failedOnce) {
        failedOnce = true;
        throw new Error('release fsync unavailable');
      }
      return openUnmocked(...args);
    });
    try {
      const tasks: Promise<void>[] = [];
      const service = new UpdateService(config, {
        fetch: async () => new Response('ok'),
        runCommand: async () => ({ stdout: '', stderr: '' }),
        backgroundRunner: (task) => { tasks.push(task()); },
        operationIdFactory: () => 'op-sync-release',
      });
      await service.applyUpdate();
      await Promise.all(tasks);
      expect(failedOnce).toBe(true);
      expect(await readFile(releaseEnvPath, 'utf8')).toBe('DRUVIA_VERSION=0.1.0\n');
      expect((await service.getStatus()).phase).toBe('rolled_back');
    } finally {
      open.mockRestore();
    }
  });

  it('selects rollback backup from the version admitted after a concurrent apply', async () => {
    const { config, stateDir } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-new');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    const status = {
      enabled: true, phase: 'succeeded' as const, currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable' as const, releaseNotesUrl: null, migration: null, operationId: null,
      lastAppliedBackup: { operationId: 'op-old', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    };
    await writeUpdateState(config.statePath, status);
    const service = new UpdateService(config, { backgroundRunner: () => undefined });
    const startOperation = Reflect.get(service, 'startOperation') as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(service, 'startOperation', async (...args: unknown[]) => {
      await writeUpdateState(config.statePath, {
        ...status,
        currentVersion: '0.3.0',
        lastAppliedBackup: { operationId: 'op-new', targetVersion: '0.3.0' },
      });
      return startOperation.apply(service, args);
    });

    await service.rollbackUpdate();
    expect((await service.getStatus()).rollbackBackupOperationId).toBe('op-new');
  });

  it('recovers a finalizing update when the detached finalizer was never launched', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'finalizing', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-apply',
      lastAppliedBackup: { operationId: 'op-apply', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        throw new CommandError(command, args, 1, '', 'Error: No such object: druvia-updater-finalizer-op-apply');
      },
    });

    await service.recoverInterruptedOperation();
    const status = await service.getStatus();
    expect(status).toMatchObject({
      phase: 'succeeded', currentVersion: '0.2.0', operationId: null,
      lastAppliedBackup: { operationId: 'op-apply', targetVersion: '0.2.0' },
    });
    expect(status.message).toContain('updater finalizer');
    expect(status.finishedAt).not.toBeNull();
  });

  it('keeps finalizing while the finalizer runs and resolves it after the container disappears', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'finalizing', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-apply',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    let running = true;
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        if (running) return { stdout: 'true\n', stderr: '' };
        throw new CommandError(command, args, 1, '', 'Error: No such container: druvia-updater-finalizer-op-apply');
      },
    });
    expect((await service.getStatus()).phase).toBe('finalizing');
    running = false;
    const [a, b] = await Promise.all([service.getStatus(), service.getStatus()]);
    expect(a.phase).toBe('succeeded');
    expect(b.phase).toBe('succeeded');
  });

  it('does not infer finalizer failure when Docker inspect itself is unavailable', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'finalizing', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-apply',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        throw new CommandError(command, args, 1, '', 'Cannot connect to the Docker daemon');
      },
    });
    await service.recoverInterruptedOperation();
    expect((await service.getStatus()).phase).toBe('finalizing');
  });
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

  it('admits only one of a concurrent rollback and update check', async () => {
    const { config, stateDir } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-last-update');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'succeeded', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: null,
      lastAppliedBackup: { operationId: 'op-last-update', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    let sequence = 0;
    const service = new UpdateService(config, {
      backgroundRunner: () => undefined,
      operationIdFactory: () => `op-${++sequence}`,
    });

    const results = await Promise.allSettled([service.rollbackUpdate(), service.checkForUpdates()]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const accepted = results.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<{ operationId: string }>;
    expect((await service.getStatus()).operationId).toBe(accepted.value.operationId);
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
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
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
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
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
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
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
    const commandArgs = commands.map((item) => item.args.join(' '));
    expect(commandArgs[0]).toContain('run --rm --no-deps api node apps/api/dist/cli/migrate.js up');
    expect(commandArgs[1]).toContain('up -d --no-deps --remove-orphans api admin deno hasura');
    expect(commandArgs[2]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commandArgs[3]).toMatch(/exec druvia-postgres psql[\s\S]*active = TRUE/);
    expect(commandArgs[4]).toContain('pg_terminate_backend');
    expect(commandArgs[5]).toMatch(/exec druvia-postgres psql[\s\S]*pg_advisory_xact_lock/);
    expect(commandArgs[6]).toContain('exec -d druvia-postgres psql');
    expect(commandArgs[7]).toContain('pg_try_advisory_lock_shared');
    expect(commandArgs.some((command) => command.includes('up -d --no-deps deno'))).toBe(true);
    expect(commandArgs.filter((command) => command.includes('up -d --no-deps --remove-orphans api admin deno hasura'))).toHaveLength(2);
    expect(commandArgs.at(-2)).toMatch(/exec druvia-postgres psql[\s\S]*active = FALSE/);
    expect(commandArgs.at(-1)).toContain('pg_advisory_lock_shared');
    const status = await service.getStatus();
    expect(status.phase).toBe('rolled_back');
    expect(status.error?.message).toContain('compose up failed');
    expect(status.message).toContain('Rolled back');
  });

  it('stops services and queries PostgreSQL without parsing a broken newly switched Compose', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const oldCompose = 'services:\n  api:\n    image: old\n';
    const brokenCompose = 'services: [invalid\n';
    const manifest = buildManifest(brokenCompose);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(composePath, oldCompose);
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest));
    await writeFile(config.stagedComposePath, brokenCompose);
    await writeFile(config.stagedManifestPath, JSON.stringify(manifest));
    await writeReadyToApplyState(config, manifest);
    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'compose' && (await readFile(composePath, 'utf8')) === brokenCompose) {
          throw new Error('failed to parse compose');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-broken-compose',
    });
    await service.applyUpdate();
    await Promise.all(tasks);
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringMatching(/^docker stop .*druvia-api .*druvia-admin .*druvia-deno/),
      expect.stringMatching(/^docker exec .*druvia-postgres psql/),
    ]));
    expect(await readFile(composePath, 'utf8')).toBe(oldCompose);
    expect((await service.getStatus()).phase).toBe('rolled_back');
  });

  it('stops a switched deployment after restart even if the active Compose cannot be parsed', async () => {
    const { config, composePath } = await createConfigRoot();
    await writeFile(composePath, 'services: [invalid\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'verifying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      startedAt: null, finishedAt: null, message: null, error: null, applyStage: 'files_switched',
    });
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'compose') throw new Error('failed to parse compose');
        return { stdout: '', stderr: '' };
      },
    });
    await service.recoverInterruptedOperation();
    expect(commands[0]).toMatch(/^docker stop .*druvia-api .*druvia-admin .*druvia-deno/);
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('does not automatically restore old release files over active v2 projection state', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const oldCompose = 'services:\n  api:\n    image: old\n';
    const newCompose = 'services:\n  api:\n    image: new\n';
    const manifest = buildManifest(newCompose);
    manifest.migrations.from = 26;
    manifest.migrations.to = 27;
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, oldCompose, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
    await writeFile(config.stagedComposePath, newCompose, 'utf8');
    await writeFile(config.stagedManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await writeReadyToApplyState(config, manifest);

    const commands: string[] = [];
    const backgroundTasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        if (args.includes('up') && args.includes('--remove-orphans')) {
          throw new Error('new services failed health startup');
        }
        if (args.join(' ').includes('pg_advisory_xact_lock')) {
          throw new Error('active Data Access v2 projection state');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { backgroundTasks.push(task()); },
      operationIdFactory: () => 'op-v2-auto-rollback',
    });

    await service.applyUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe(buildStagedEnv(manifest));
    await expect(readFile(composePath, 'utf8')).resolves.toBe(newCompose);
    expect(commands).toHaveLength(6);
    expect(commands[2]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commands[3]).toMatch(/exec druvia-postgres psql[\s\S]*active = TRUE/);
    expect(commands[4]).toContain('pg_terminate_backend');
    expect(commands[5]).toMatch(/exec druvia-postgres psql[\s\S]*pg_advisory_xact_lock/);
    expect(commands.some((command) => command.includes('active = FALSE'))).toBe(false);
    expect(commands.some((command) => command.includes('up -d --no-deps deno'))).toBe(false);
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.error?.message).toContain('active Data Access v2 projection state');
    expect(status.error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
    await expect(service.downloadUpdate()).rejects.toMatchObject({ code: 'UPDATE_ROLLBACK_RECOVERY_REQUIRED' });
  });

  it('rejects apply when no downloaded update is ready even if stale staged files exist', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    const composeContent = 'services: {}\n';
    const manifest = buildManifest(composeContent);
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, composeContent, 'utf8');
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
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
    await writeFile(config.stagedReleaseEnvPath, buildStagedEnv(manifest), 'utf8');
    await writeFile(config.stagedComposePath, composeContent, 'utf8');
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

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe(buildStagedEnv(manifest));
    expect(commands.slice(0, 2).map((item) => `${item.command} ${item.args.join(' ')}`)).toEqual([
      'docker compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' run --rm --no-deps api node apps/api/dist/cli/migrate.js up',
      'docker compose --project-directory ' + config.compose.projectDirectory + ' --env-file ' + config.compose.baseEnvFile + ' --env-file ' + config.compose.releaseEnvFile + ' -f ' + config.compose.composeFile + ' up -d --no-deps --remove-orphans api admin deno hasura',
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
    expect(status.lastAppliedBackup).toEqual({ operationId: 'op-apply', targetVersion: '0.2.0' });
    expect(status.message).toBe('Updated to 0.2.0; updater finalizer scheduled');
  });

  it('checks live projection state before manual rollback even when migration state is absent', async () => {
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
      applyStage: 'files_switched',
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
    const commandArgs = commands.map((item) => item.args.join(' '));
    expect(commandArgs[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commandArgs[1]).toMatch(/exec druvia-postgres psql[\s\S]*active = TRUE/);
    expect(commandArgs[2]).toContain('pg_terminate_backend');
    expect(commandArgs[3]).toMatch(/exec druvia-postgres psql[\s\S]*pg_advisory_xact_lock/);
    expect(commandArgs[4]).toContain('exec -d druvia-postgres psql');
    expect(commandArgs[5]).toContain('pg_try_advisory_lock_shared');
    expect(commandArgs.some((command) => command.includes('up -d --no-deps deno'))).toBe(true);
    expect(commandArgs.some((command) => command.includes('up -d --no-deps --remove-orphans api admin deno hasura'))).toBe(true);
    expect(commandArgs.at(-2)).toMatch(/exec druvia-postgres psql[\s\S]*active = FALSE/);
    expect(commandArgs.at(-1)).toContain('pg_advisory_lock_shared');
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
      applyStage: 'files_switched',
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
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        if (args.includes('up')) throw new Error('rollback compose failed');
        return { stdout: '', stderr: '' };
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
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commands[1]).toMatch(/exec druvia-postgres psql[\s\S]*active = TRUE/);
    expect(commands[2]).toContain('pg_terminate_backend');
    expect(commands[3]).toMatch(/exec druvia-postgres psql[\s\S]*pg_advisory_xact_lock/);
    expect(commands[4]).toContain('exec -d druvia-postgres psql');
    expect(commands[5]).toContain('pg_try_advisory_lock_shared');
    expect(commands.at(-1)).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commands.findLastIndex((command) => /active = TRUE/.test(command)))
      .toBeGreaterThan(commands.findLastIndex((command) => /active = FALSE/.test(command)));
  });

  it('stops old services when rollback gate teardown fails after old API health succeeds', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });

    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async (_command, args) => {
        const joined = args.join(' ');
        commands.push(joined);
        if (joined.includes('active = FALSE') && commands.some((cmd) => cmd.includes('up -d --no-deps --remove-orphans'))) {
          throw new Error('gate teardown failed');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await service.rollbackUpdate();
    await Promise.all(tasks);
    expect(commands.at(-1)).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.operationId).toBe('op-original');
  });

  it('preserves an active rollback gate when stale holder cleanup fails during retry', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    let gateActive = true;
    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        const joined = args.join(' ');
        commands.push(joined);
        if (joined.includes('active = FALSE')) gateActive = false;
        if (joined.includes('active = TRUE')) gateActive = true;
        if (joined.includes('$rollback_lock_release$')) throw new Error('stale holder cleanup failed');
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await service.rollbackUpdate();
    await Promise.all(tasks);

    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commands[1]).toContain('active = TRUE');
    expect(commands[2]).toContain('$rollback_lock_release$');
    expect(commands.every((command) => !command.includes('active = FALSE'))).toBe(true);
    expect(gateActive).toBe(true);
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('stops old services when the gate was disabled but holder-release confirmation fails', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    let gateActive = false;
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async (_command, args) => {
        const joined = args.join(' ');
        commands.push(joined);
        if (joined.includes('active = TRUE')) gateActive = true;
        if (joined.includes('active = FALSE')) gateActive = false;
        if (joined.includes('$rollback_lock_release$')
          && commands.some((cmd) => cmd.includes('up -d --no-deps --remove-orphans'))) {
          throw new Error('holder release could not be confirmed');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await service.rollbackUpdate();
    await Promise.all(tasks);
    expect(commands.at(-3)).toContain('$rollback_lock_release$');
    expect(commands.at(-2)).toContain('active = TRUE');
    expect(commands.at(-1)).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(gateActive).toBe(true);
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('stops old services if the holder disappears while a health check is pending', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });

    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    let holderLost = false;
    const service = new UpdateService(config, {
      fetch: async () => { holderLost = true; return new Response('ok'); },
      runCommand: async (_command, args) => {
        const joined = args.join(' ');
        commands.push(joined);
        if (holderLost && joined.includes('pg_try_advisory_lock_shared')) {
          throw new Error('holder lost');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await service.rollbackUpdate();
    await Promise.all(tasks);
    expect(commands.at(-1)).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect((await service.getStatus()).phase).toBe('failed');
  });

  it('aborts a pending old API health check when the holder dies in the background', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });

    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    let holderLost = false;
    const service = new UpdateService(config, {
      fetch: async (_url, options) => {
        holderLost = true;
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('health check aborted')));
        });
      },
      runCommand: async (_command, args) => {
        const joined = args.join(' ');
        commands.push(joined);
        if (holderLost && joined.includes('pg_try_advisory_lock_shared')) throw new Error('holder lost');
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await service.rollbackUpdate();
    await Promise.race([
      Promise.all(tasks),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('watchdog timeout')), 1500)),
    ]);
    expect(commands.at(-1)).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('reclaims an interrupted rollback after updater restart while preserving its backup', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'verifying', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const commands: string[] = [];
    const restarted = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
    });
    const app = buildApp({ updaterSecret: 'secret', service: restarted });
    await app.ready();
    const status = await restarted.getStatus();
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(status.phase).toBe('failed');
    expect(status.operationId).toBe('op-original');
    expect(status.error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
    await expect(restarted.checkForUpdates()).rejects.toMatchObject({ code: 'UPDATE_ROLLBACK_RECOVERY_REQUIRED' });
    await app.close();
  });

  it('keeps the original backup id when a manual rollback is interrupted by updater restart', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-original');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const interrupted = new UpdateService(config, {
      operationIdFactory: () => 'op-retry', backgroundRunner: () => undefined,
    });
    await interrupted.rollbackUpdate();
    const restarted = new UpdateService(config, { runCommand: async () => ({ stdout: '', stderr: '' }) });
    await restarted.recoverInterruptedOperation();
    const status = await restarted.getStatus();
    expect(status.operationId).toBe('op-original');
    expect(status.error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('persists the selected backup id before a rollback from a successful update can be interrupted', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-last-update');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'succeeded', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: null,
      lastAppliedBackup: { operationId: 'op-last-update', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const interrupted = new UpdateService(config, {
      operationIdFactory: () => 'op-manual-rollback', backgroundRunner: () => undefined,
    });
    await interrupted.rollbackUpdate();
    expect((await interrupted.getStatus()).rollbackBackupOperationId).toBe('op-last-update');

    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    const restarted = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-retry',
    });
    await restarted.recoverInterruptedOperation();
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect((await restarted.getStatus()).operationId).toBe('op-last-update');
    await restarted.rollbackUpdate();
    await Promise.all(tasks);
    expect((await restarted.getStatus()).phase).toBe('rolled_back');
    expect((await restarted.getStatus()).currentVersion).toBe('0.1.0');
    expect((await restarted.getStatus()).lastAppliedBackup).toBeNull();
    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.1.0\n');
  });

  it('uses the successful apply backup after a later update check fails', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-last-update');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n');
    await writeFile(composePath, 'services: {}\n');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-check',
      lastAppliedBackup: { operationId: 'op-last-update', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: 'check failed',
      error: { code: 'UPDATE_OPERATION_FAILED', message: 'check failed' },
    });
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      fetch: async () => new Response('ok'),
      runCommand: async () => ({ stdout: '', stderr: '' }),
      backgroundRunner: (task) => { tasks.push(task()); },
      operationIdFactory: () => 'op-rollback',
    });
    const accepted = await service.rollbackUpdate();
    expect(accepted.status.rollbackBackupOperationId).toBe('op-last-update');
    await Promise.all(tasks);
    expect((await service.getStatus()).phase).toBe('rolled_back');
    expect((await service.getStatus()).currentVersion).toBe('0.1.0');
  });

  it('rejects a failed check with no tracked apply backup without entering recovery mode', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-check',
      startedAt: null, finishedAt: null, message: 'check failed',
      error: { code: 'UPDATE_OPERATION_FAILED', message: 'check failed' },
    });
    const service = new UpdateService(config);
    await expect(service.rollbackUpdate()).rejects.toBeInstanceOf(UpdatePreconditionError);
    expect((await service.getStatus()).operationId).toBe('op-check');
    expect((await service.getStatus()).error?.code).toBe('UPDATE_OPERATION_FAILED');
  });

  it('rejects a tracked backup belonging to another installed version', async () => {
    const { config, stateDir } = await createConfigRoot();
    await mkdir(join(stateDir, 'backups', 'op-other-version'), { recursive: true });
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'succeeded', currentVersion: '0.3.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: null,
      lastAppliedBackup: { operationId: 'op-other-version', targetVersion: '0.2.0' },
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const service = new UpdateService(config);
    await expect(service.rollbackUpdate()).rejects.toBeInstanceOf(UpdatePreconditionError);
    expect((await service.getStatus()).phase).toBe('succeeded');
  });

  it('allows retry without rollback when apply is interrupted before release files switch', async () => {
    const { config, releaseEnvPath, composePath } = await createConfigRoot();
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(composePath, 'services: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'applying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-early',
      startedAt: null, finishedAt: null, message: null, error: null,
      applyStage: 'preparing_backup',
    });
    const commands: string[] = [];
    const restarted = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: () => undefined,
    });
    await restarted.recoverInterruptedOperation();
    expect(commands).toEqual([]);
    expect((await restarted.getStatus()).error?.code).toBe('UPDATE_OPERATION_FAILED');
    await expect(restarted.downloadUpdate()).resolves.toMatchObject({ operationId: expect.any(String) });
  });

  it('fails closed when backup_ready disagrees with active release files after a crash', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-crash');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(composePath, 'services:\n  api: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'applying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-crash',
      startedAt: null, finishedAt: null, message: null, error: null, applyStage: 'backup_ready',
    });
    const commands: string[] = [];
    const restarted = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
    });
    await restarted.recoverInterruptedOperation();
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect((await restarted.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('fails closed when an active release file is missing during early apply recovery', async () => {
    const { config, releaseEnvPath } = await createConfigRoot();
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.1.0\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'applying', currentVersion: '0.1.0', availableVersion: '0.2.0',
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-crash',
      startedAt: null, finishedAt: null, message: null, error: null, applyStage: 'preparing_backup',
    });
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
    });
    await service.recoverInterruptedOperation();
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('rejects an incomplete rollback backup before changing the gate or running Compose', async () => {
    const { config, stateDir } = await createConfigRoot();
    await mkdir(join(stateDir, 'backups', 'op-original'), { recursive: true });
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'failed', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-original',
      applyStage: 'files_switched',
      startedAt: null, finishedAt: null, message: null,
      error: { code: 'UPDATE_ROLLBACK_RECOVERY_REQUIRED', message: 'interrupted rollback' },
    });
    const commands: string[] = [];
    const tasks: Promise<void>[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { tasks.push(task()); },
    });
    await expect(service.rollbackUpdate()).rejects.toMatchObject({ code: 'UPDATE_BACKUP_NOT_AVAILABLE' });
    expect(tasks).toEqual([]);
    expect(commands).toEqual([]);
    expect((await service.getStatus()).error?.code).toBe('UPDATE_ROLLBACK_RECOVERY_REQUIRED');
  });

  it('does not require rollback for a check interrupted before release files changed', async () => {
    const { config } = await createConfigRoot();
    await writeUpdateState(config.statePath, {
      enabled: true, phase: 'checking', currentVersion: '0.2.0', availableVersion: null,
      channel: 'stable', releaseNotesUrl: null, migration: null, operationId: 'op-check',
      startedAt: null, finishedAt: null, message: null, error: null,
    });
    const service = new UpdateService(config, { backgroundRunner: () => undefined });
    await service.recoverInterruptedOperation();
    expect((await service.getStatus()).phase).toBe('failed');
    await expect(service.checkForUpdates()).resolves.toMatchObject({ operationId: expect.any(String) });
  });

  it('blocks rollback of migration 027 or newer when v2 projection state exists', async () => {
    const { config, stateDir, releaseEnvPath, composePath } = await createConfigRoot();
    const backupDir = join(stateDir, 'backups', 'op-v2');
    await mkdir(backupDir, { recursive: true });
    await writeFile(releaseEnvPath, 'DRUVIA_VERSION=0.3.0\n', 'utf8');
    await writeFile(composePath, 'services:\n  api: {}\n', 'utf8');
    await writeFile(join(backupDir, '.env.release'), 'DRUVIA_VERSION=0.2.0\n', 'utf8');
    await writeFile(join(backupDir, 'docker-compose.release.yml'), 'services: {}\n', 'utf8');
    await writeUpdateState(config.statePath, {
      enabled: true,
      phase: 'failed',
      currentVersion: '0.3.0',
      applyStage: 'files_switched',
      availableVersion: null,
      channel: 'stable',
      releaseNotesUrl: null,
      migration: {
        required: true, from: 26, to: 27, requiresBackup: true, reversible: false,
      },
      operationId: 'op-v2',
      startedAt: null,
      finishedAt: null,
      message: 'manual recovery required',
      error: { code: 'UPDATE_OPERATION_FAILED', message: 'manual recovery required' },
    });

    const backgroundTasks: Promise<void>[] = [];
    const commands: string[] = [];
    const service = new UpdateService(config, {
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        if (args.join(' ').includes('pg_advisory_xact_lock')) {
          throw new Error('active Data Access v2 projection state');
        }
        return { stdout: '', stderr: '' };
      },
      backgroundRunner: (task) => { backgroundTasks.push(task()); },
      operationIdFactory: () => 'op-v2-rollback',
    });

    await service.rollbackUpdate();
    await Promise.all(backgroundTasks);

    await expect(readFile(releaseEnvPath, 'utf8')).resolves.toBe('DRUVIA_VERSION=0.3.0\n');
    expect(commands).toHaveLength(4);
    expect(commands[0]).toContain('stop --time 10 druvia-api druvia-admin druvia-deno');
    expect(commands[1]).toMatch(/exec druvia-postgres psql[\s\S]*active = TRUE/);
    expect(commands[2]).toContain('pg_terminate_backend');
    expect(commands[3]).toMatch(/exec druvia-postgres psql[\s\S]*pg_advisory_xact_lock/);
    expect(commands.some((command) => command.includes('active = FALSE'))).toBe(false);
    const status = await service.getStatus();
    expect(status.phase).toBe('failed');
    expect(status.operationId).toBe('op-v2');
    expect(status.error?.message).toContain('active Data Access v2 projection state');
  });
});
