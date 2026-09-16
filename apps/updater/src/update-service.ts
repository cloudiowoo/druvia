import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join } from 'node:path';
import type { DruviaReleaseManifest, DruviaUpdateStatus } from '@druvia/shared';
import { isDruviaUpdateMutatingPhase } from '@druvia/shared';
import { CommandError, runCommand, type CommandRunner } from './command.js';
import type { UpdaterConfig } from './config.js';
import {
  buildComposeArgs,
  buildDockerImagePullArgs,
  buildProjectionRollbackCheckArgs,
  buildProjectionRollbackGateArgs,
  buildProjectionRollbackLockHolderArgs,
  buildProjectionRollbackLockReadyArgs,
  buildProjectionRollbackLockReleaseWaitArgs,
  buildProjectionRollbackStaleHolderReleaseArgs,
  buildRollbackStopArgs,
  buildUpdaterFinalizerRunArgs,
} from './compose.js';
import {
  buildImageRef,
  UpdateManifestError,
  validateReleaseManifest,
  verifySha256,
} from './manifest.js';
import { buildPgDumpCommand } from './postgres-backup.js';
import { createDefaultUpdateStatus, readUpdateState, writeUpdateState } from './state.js';

export interface UpdateOperationAccepted {
  operationId: string;
  status: DruviaUpdateStatus;
}

export interface UpdateServiceDependencies {
  fetch?: typeof fetch;
  runCommand?: CommandRunner;
  backgroundRunner?: (task: () => Promise<void>) => void;
  operationIdFactory?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class UpdateOperationInProgressError extends Error {
  constructor(public readonly operationId: string | null) {
    super('Update operation is already in progress');
    this.name = 'UpdateOperationInProgressError';
  }
}

export class UpdatePreconditionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UpdatePreconditionError';
  }
}

class RollbackRecoveryRequiredError extends Error {
  readonly code = 'UPDATE_ROLLBACK_RECOVERY_REQUIRED';
}

export interface UpdateRouteService {
  getStatus(): Promise<DruviaUpdateStatus>;
  checkForUpdates(): Promise<UpdateOperationAccepted>;
  downloadUpdate(): Promise<UpdateOperationAccepted>;
  applyUpdate(): Promise<UpdateOperationAccepted>;
  rollbackUpdate(): Promise<UpdateOperationAccepted>;
  restartServices(): Promise<UpdateOperationAccepted>;
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof UpdateManifestError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RollbackRecoveryRequiredError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'UPDATE_OPERATION_FAILED', message: error.message };
  }
  return { code: 'UPDATE_OPERATION_FAILED', message: String(error) };
}

async function ensureParent(path: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await fs.readFile(path, 'utf8');
  return JSON.parse(content) as T;
}

async function atomicWrite(path: string, tempPath: string, content: string | Buffer): Promise<void> {
  await ensureParent(tempPath);
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, path);
}

async function syncReleaseFiles(paths: string[], extraDirectories: string[] = []): Promise<void> {
  for (const path of paths) {
    const file = await fs.open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  for (const path of new Set([...paths.map(dirname), ...extraDirectories])) {
    const directory = await fs.open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function mergeEnvContent(content: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = content.trimEnd().length > 0 ? content.trimEnd().split(/\r?\n/) : [];
  const merged = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    const value = remaining.get(key);
    if (value === undefined) return line;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) {
    merged.push(`${key}=${value}`);
  }

  return `${merged.join('\n')}\n`;
}

function sanitizeDockerNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}

const rollbackContainerNames = ['druvia-api', 'druvia-admin', 'druvia-deno'] as const;

function isMissingDockerContainer(error: unknown, name: string): boolean {
  return error instanceof CommandError && error.command === 'docker'
    && (error.stderr.trim().endsWith(`No such container: ${name}`)
      || error.stderr.trim().endsWith(`No such object: ${name}`));
}

export class UpdateService implements UpdateRouteService {
  private activeOperationId: string | null = null;
  private finalizingReconciliation: Promise<DruviaUpdateStatus> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly runCommandImpl: CommandRunner;
  private readonly backgroundRunner: (task: () => Promise<void>) => void;
  private readonly operationIdFactory: () => string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: UpdaterConfig,
    deps: UpdateServiceDependencies = {}
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.runCommandImpl = deps.runCommand ?? runCommand;
    this.backgroundRunner = deps.backgroundRunner ?? ((task) => {
      void task();
    });
    this.operationIdFactory = deps.operationIdFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getStatus(): Promise<DruviaUpdateStatus> {
    const current = await readUpdateState(
      this.config.statePath,
      createDefaultUpdateStatus({
        currentVersion: this.config.currentVersion,
        channel: this.config.channel,
      })
    );
    if (current.phase !== 'finalizing' || !current.operationId || this.activeOperationId) return current;
    if (!this.finalizingReconciliation) {
      this.finalizingReconciliation = this.reconcileFinalizing(current);
    }
    try {
      return await this.finalizingReconciliation;
    } finally {
      this.finalizingReconciliation = null;
    }
  }

  private async reconcileFinalizing(current: DruviaUpdateStatus): Promise<DruviaUpdateStatus> {
    const name = `druvia-updater-finalizer-${sanitizeDockerNameSegment(current.operationId!)}`;
    let stopped = false;
    try {
      const result = await this.runCommandImpl('docker', ['inspect', '--format', '{{.State.Running}}', name]);
      stopped = result.stdout.trim() === 'false';
    } catch (error) {
      stopped = error instanceof CommandError && error.command === 'docker'
        && /\bNo such (?:object|container):\s/.test(error.stderr);
    }
    if (!stopped) return current;

    const latest = await readUpdateState(this.config.statePath, current);
    if (latest.phase !== 'finalizing' || latest.operationId !== current.operationId) return latest;
    const finished: DruviaUpdateStatus = {
      ...latest,
      phase: 'succeeded',
      operationId: null,
      finishedAt: this.now().toISOString(),
      message: `Updated to ${latest.currentVersion}; updater finalizer failed after interruption and can be retried manually`,
      error: null,
    };
    await writeUpdateState(this.config.statePath, finished);
    return finished;
  }

  async recoverInterruptedOperation(): Promise<void> {
    const current = await this.getStatus();
    if (!isDruviaUpdateMutatingPhase(current.phase) || current.phase === 'finalizing') return;
    const needsRollback = (current.phase === 'applying' || current.phase === 'verifying')
      && (current.applyStage !== 'preparing_backup' && current.applyStage !== 'backup_ready'
        || await this.releaseFilesDiverged(current));
    if (needsRollback) {
      await this.stopRollbackServices();
    }
    await this.writeState({
      phase: 'failed',
      operationId: needsRollback
        ? current.rollbackBackupOperationId ?? current.operationId
        : current.operationId,
      rollbackBackupOperationId: null,
      applyStage: null,
      finishedAt: this.now().toISOString(),
      message: needsRollback
        ? 'Updater restarted during deployment; inspect and retry rollback'
        : 'Updater restarted during an operation; retry the command',
      error: {
        code: needsRollback ? 'UPDATE_ROLLBACK_RECOVERY_REQUIRED' : 'UPDATE_OPERATION_FAILED',
        message: needsRollback
          ? 'Updater restarted during deployment; inspect and retry rollback'
          : 'Updater restarted during an operation; retry the command',
      },
    });
  }

  private async releaseFilesDiverged(current: DruviaUpdateStatus): Promise<boolean> {
    if (!current.operationId) return true;
    const backupDir = join(this.config.stateDir, 'backups', current.operationId);
    try {
      const activeEnv = await fs.readFile(this.config.compose.releaseEnvFile);
      if (parseEnv(activeEnv.toString()).DRUVIA_VERSION !== current.currentVersion) return true;
      const files = [
        [this.config.compose.releaseEnvFile, join(backupDir, '.env.release')],
        [this.config.compose.composeFile, join(backupDir, 'docker-compose.release.yml')],
      ];
      for (const [active, backup] of files) {
        const activeContent = await fs.readFile(active);
        try {
          if (!activeContent.equals(await fs.readFile(backup))) return true;
        } catch (error) {
          if (current.applyStage !== 'preparing_backup'
            || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
            return true;
          }
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  async checkForUpdates(): Promise<UpdateOperationAccepted> {
    return this.startOperation('checking', async () => {
      try {
        const manifest = await this.fetchReleaseManifest();
        await this.writeState({
          phase: 'available',
          availableVersion: manifest.version,
          releaseNotesUrl: manifest.releaseNotesUrl,
          migration: manifest.migrations,
          operationId: null,
          finishedAt: this.now().toISOString(),
          message: `Version ${manifest.version} is available`,
        });
      } catch (error) {
        if (error instanceof UpdateManifestError && error.code === 'NO_UPDATE_AVAILABLE') {
          await this.writeState({
            phase: 'idle',
            availableVersion: null,
            releaseNotesUrl: null,
            migration: null,
            operationId: null,
            finishedAt: this.now().toISOString(),
            message: 'Current version is up to date',
          });
          return;
        }
        throw error;
      }
    });
  }

  async downloadUpdate(): Promise<UpdateOperationAccepted> {
    return this.startOperation('downloading', async () => {
      const manifest = await this.fetchReleaseManifest();
      await writeJsonFile(this.config.stagedManifestPath, manifest);
      const images = [
        manifest.images.api,
        manifest.images.admin,
        manifest.images.worker,
        manifest.images.updater,
      ];

      for (const image of images) {
        await this.runCommandImpl('docker', buildDockerImagePullArgs(buildImageRef(image)));
      }

      const composeContent = await this.downloadText(manifest.compose.url);
      if (!verifySha256(composeContent, manifest.compose.sha256)) {
        throw new Error('Downloaded release compose checksum does not match manifest');
      }

      await atomicWrite(this.config.stagedComposePath, this.config.nextComposePath, composeContent);
      const currentEnv = await fs.readFile(this.config.compose.releaseEnvFile, 'utf8').catch((error: unknown) => {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return '';
        throw error;
      });
      const stagedEnv = mergeEnvContent(currentEnv, {
        DRUVIA_VERSION: manifest.version,
        DRUVIA_API_IMAGE: buildImageRef(manifest.images.api),
        DRUVIA_ADMIN_IMAGE: buildImageRef(manifest.images.admin),
        DRUVIA_WORKER_IMAGE: buildImageRef(manifest.images.worker),
        DRUVIA_UPDATER_IMAGE: buildImageRef(manifest.images.updater),
      });
      await atomicWrite(this.config.stagedReleaseEnvPath, this.config.nextReleaseEnvPath, stagedEnv);

      await syncReleaseFiles([
        this.config.stagedManifestPath,
        this.config.stagedComposePath,
        this.config.stagedReleaseEnvPath,
      ]);

      await this.writeState({
        phase: 'ready_to_apply',
        availableVersion: manifest.version,
        releaseNotesUrl: manifest.releaseNotesUrl,
        migration: manifest.migrations,
        operationId: null,
        finishedAt: this.now().toISOString(),
        message: `Version ${manifest.version} is ready to apply`,
      });
    });
  }

  async applyUpdate(): Promise<UpdateOperationAccepted> {
    return this.startOperation('applying', async (operationId) => {
      const current = await this.getStatus();
      const manifest = validateReleaseManifest(
        await readJsonFile<DruviaReleaseManifest>(this.config.stagedManifestPath),
        {
          currentVersion: current.currentVersion,
          currentUpdaterVersion: this.config.currentUpdaterVersion,
          channel: this.config.channel,
          allowedHosts: this.config.allowedHosts,
        }
      );
      if (manifest.version !== current.availableVersion
        || JSON.stringify(manifest.migrations) !== JSON.stringify(current.migration)
        || !verifySha256(await fs.readFile(this.config.stagedComposePath, 'utf8'), manifest.compose.sha256)) {
        throw new UpdatePreconditionError('UPDATE_STAGED_ASSETS_INVALID', 'Staged release does not match the admitted manifest');
      }
      const stagedEnv = parseEnv(await fs.readFile(this.config.stagedReleaseEnvPath, 'utf8'));
      const expectedImages = {
        DRUVIA_API_IMAGE: buildImageRef(manifest.images.api),
        DRUVIA_ADMIN_IMAGE: buildImageRef(manifest.images.admin),
        DRUVIA_WORKER_IMAGE: buildImageRef(manifest.images.worker),
        DRUVIA_UPDATER_IMAGE: buildImageRef(manifest.images.updater),
      };
      if (stagedEnv.DRUVIA_VERSION !== manifest.version
        || Object.entries(expectedImages).some(([key, image]) => stagedEnv[key] !== image)) {
        throw new UpdatePreconditionError('UPDATE_STAGED_ASSETS_INVALID', 'Staged release env does not match the manifest');
      }

      const backupDir = join(this.config.stateDir, 'backups', operationId);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(this.config.compose.releaseEnvFile, join(backupDir, '.env.release'));
      await fs.copyFile(this.config.compose.composeFile, join(backupDir, 'docker-compose.release.yml'));

      if (manifest.migrations.requiresBackup) {
        await this.createDatabaseBackup(backupDir);
      }

      await syncReleaseFiles([
        join(backupDir, '.env.release'),
        join(backupDir, 'docker-compose.release.yml'),
        ...(manifest.migrations.requiresBackup
          ? [join(backupDir, 'postgres.dump'), join(backupDir, 'postgres.dump.sha256')]
          : []),
      ], [dirname(backupDir), this.config.stateDir]);

      await this.writeState({ applyStage: 'backup_ready' });
      let releaseFilesSwitched = false;
      try {
        await this.writeState({ applyStage: 'files_switched' });
        releaseFilesSwitched = true;
        await fs.rename(this.config.stagedComposePath, this.config.compose.composeFile);
        await fs.rename(this.config.stagedReleaseEnvPath, this.config.compose.releaseEnvFile);
        await syncReleaseFiles([this.config.compose.composeFile, this.config.compose.releaseEnvFile]);

        if (manifest.migrations.required) {
          await this.runCommandImpl('docker', buildComposeArgs('migrate', this.config.compose));
        }
        await this.runCommandImpl('docker', buildComposeArgs('up', this.config.compose));
        await this.writeState({ phase: 'verifying', message: 'Verifying services after update' });
        await this.pollHealthChecks();
      } catch (error) {
        if (!releaseFilesSwitched) throw error;

        try {
          await this.prepareProjectionRollback();
          await this.completeProjectionRollback(backupDir);
        } catch (rollbackError) {
          throw new RollbackRecoveryRequiredError(
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          );
        }

        const normalized = normalizeError(error);
        await this.writeState({
          phase: 'rolled_back',
          availableVersion: null,
          finishedAt: this.now().toISOString(),
          message: this.buildAutomaticRollbackMessage(backupDir, manifest),
          error: normalized,
          operationId: null,
          applyStage: null,
        });
        return;
      }

      await this.writeState({
        phase: 'finalizing',
        currentVersion: manifest.version,
        lastAppliedBackup: { operationId, targetVersion: manifest.version },
        applyStage: null,
        availableVersion: null,
        releaseNotesUrl: manifest.releaseNotesUrl,
        migration: manifest.migrations,
        finishedAt: null,
        message: `Updated to ${manifest.version}; updater finalizer scheduled`,
      });

      try {
        await this.runCommandImpl('docker', buildUpdaterFinalizerRunArgs({
          compose: this.config.compose,
          delaySeconds: this.config.updaterFinalizerDelaySeconds,
          finalizerImage: buildImageRef(manifest.images.updater),
          finalizerName: `druvia-updater-finalizer-${sanitizeDockerNameSegment(operationId)}`,
          targetVersion: manifest.version,
          updaterContainerName: this.config.updaterContainerName,
        }));
      } catch {
        await this.writeState({
          phase: 'succeeded',
          finishedAt: this.now().toISOString(),
          operationId: null,
          message: `Updated to ${manifest.version}; updater finalizer failed and can be retried manually`,
        });
      }
    }, (current) => {
      if (current.phase !== 'ready_to_apply') {
        throw new UpdatePreconditionError('UPDATE_NOT_READY', 'No downloaded update is ready to apply');
      }
    });
  }

  async rollbackUpdate(): Promise<UpdateOperationAccepted> {
    let backupOperationId = '';
    let restoredVersion = '';
    let previousLastAppliedBackup: DruviaUpdateStatus['lastAppliedBackup'] = null;

    return this.startOperation('applying', async () => {
      const backupDir = this.resolveBackupDir(backupOperationId);
      try {
        await this.prepareProjectionRollback();
        await this.completeProjectionRollback(backupDir);
        await this.writeState({
          phase: 'rolled_back',
          currentVersion: restoredVersion,
          availableVersion: null,
          operationId: null,
          rollbackBackupOperationId: null,
          lastAppliedBackup: previousLastAppliedBackup?.operationId === backupOperationId
            ? null : previousLastAppliedBackup ?? null,
          applyStage: null,
          finishedAt: this.now().toISOString(),
          message: `Rolled back using backup ${backupDir}`,
          error: null,
        });
      } catch (error) {
        await this.writeState({ operationId: backupOperationId, rollbackBackupOperationId: null });
        throw new RollbackRecoveryRequiredError(error instanceof Error ? error.message : String(error));
      }
    }, undefined, true, async (current) => {
      const recoveringFailedApply = current.phase === 'failed'
        && (current.applyStage === 'files_switched'
          || current.error?.code === 'UPDATE_ROLLBACK_RECOVERY_REQUIRED');
      const selected = recoveringFailedApply
        ? current.operationId
        : current.lastAppliedBackup?.targetVersion === current.currentVersion
          ? current.lastAppliedBackup.operationId : null;
      if (!selected) {
        throw new UpdatePreconditionError('UPDATE_BACKUP_NOT_AVAILABLE', 'No matching apply backup is available for rollback');
      }
      const backupDir = this.resolveBackupDir(selected);
      try {
        await this.assertRollbackBackupComplete(backupDir);
        restoredVersion = parseEnv(await fs.readFile(join(backupDir, '.env.release'), 'utf8')).DRUVIA_VERSION ?? '';
      } catch {
        throw new UpdatePreconditionError('UPDATE_BACKUP_NOT_AVAILABLE', 'Rollback backup files are missing or invalid');
      }
      if (!restoredVersion) {
        throw new UpdatePreconditionError('UPDATE_BACKUP_NOT_AVAILABLE', 'Rollback backup has no DRUVIA_VERSION');
      }
      backupOperationId = selected;
      previousLastAppliedBackup = current.lastAppliedBackup;
      return selected;
    });
  }

  async restartServices(): Promise<UpdateOperationAccepted> {
    return this.startOperation('restarting', async () => {
      await this.runCommandImpl('docker', buildComposeArgs('restart', this.config.compose));
      await this.writeState({
        phase: 'succeeded',
        finishedAt: this.now().toISOString(),
        message: 'Services restarted',
        operationId: null,
      });
    });
  }

  private async assertProjectionRollbackSafe(): Promise<void> {
    await this.runCommandImpl(
      'docker',
      buildProjectionRollbackCheckArgs(this.config.compose, this.config.database)
    );
  }

  private async enableProjectionRollbackGate(): Promise<void> {
    await this.runCommandImpl(
      'docker',
      buildProjectionRollbackGateArgs(this.config.compose, this.config.database, 'enable')
    );
  }

  private async disableProjectionRollbackGate(requireHolder = false): Promise<void> {
    await this.runCommandImpl(
      'docker',
      buildProjectionRollbackGateArgs(this.config.compose, this.config.database, 'disable', requireHolder)
    );
    await this.runCommandImpl(
      'docker',
      buildProjectionRollbackLockReleaseWaitArgs(this.config.compose, this.config.database, requireHolder)
    );
  }

  private async stopRollbackServices(): Promise<void> {
    try {
      await this.runCommandImpl('docker', buildRollbackStopArgs());
    } catch (error) {
      if (!rollbackContainerNames.some((name) => isMissingDockerContainer(error, name))) throw error;
      let stopFailure: unknown = null;
      for (const name of rollbackContainerNames) {
        try {
          await this.runCommandImpl('docker', ['stop', '--time', '10', name]);
        } catch (stopError) {
          if (!isMissingDockerContainer(stopError, name)) stopFailure ??= stopError;
        }
      }
      if (stopFailure) throw stopFailure;
    }
  }

  private async startProjectionRollbackLockHolder(): Promise<void> {
    await this.runCommandImpl(
      'docker',
      buildProjectionRollbackLockHolderArgs(this.config.compose, this.config.database)
    );
  }

  private async waitForProjectionRollbackLock(): Promise<void> {
    let lastError: unknown = new Error('file rollback lock holder is not ready');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await this.runCommandImpl(
          'docker',
          buildProjectionRollbackLockReadyArgs(this.config.compose, this.config.database)
        );
        return;
      } catch (error) {
        lastError = error;
        await this.sleep(100);
      }
    }
    throw lastError;
  }

  private async prepareProjectionRollback(): Promise<void> {
    await this.stopRollbackServices();
    await this.enableProjectionRollbackGate();
    await this.runCommandImpl('docker', buildProjectionRollbackStaleHolderReleaseArgs(
      this.config.compose, this.config.database
    ));
    await this.assertProjectionRollbackSafe();
    await this.startProjectionRollbackLockHolder();
    await this.waitForProjectionRollbackLock();
  }

  private async completeProjectionRollback(backupDir: string): Promise<void> {
    let holderFailure: unknown = null;
    let probePending: Promise<void> | null = null;
    const abort = new AbortController();
    const probe = async () => {
      if (holderFailure) throw holderFailure;
      await this.runCommandImpl(
        'docker', buildProjectionRollbackLockReadyArgs(this.config.compose, this.config.database)
      );
      if (holderFailure) throw holderFailure;
    };
    const watchdog = setInterval(() => {
      if (probePending) return;
      probePending = probe().catch(async (error: unknown) => {
        holderFailure = error;
        abort.abort();
        try {
          await this.stopRollbackServices();
        } catch (stopError) {
          holderFailure = stopError;
        }
      }).finally(() => { probePending = null; });
    }, 250);

    try {
      await probe();
      await this.restoreBackup(backupDir);
      await probe();
      await this.runCommandImpl('docker', buildComposeArgs('rollbackWorker', this.config.compose), { signal: abort.signal });
      await probe();
      await this.runCommandImpl('docker', buildComposeArgs('rollbackUp', this.config.compose), { signal: abort.signal });
      await probe();
      await this.writeState({ phase: 'verifying', message: 'Verifying services after rollback' });
      await this.pollHealthChecks(probe, abort.signal);
      await probe();
      clearInterval(watchdog);
      await probePending;
      if (holderFailure) throw holderFailure;
      await this.disableProjectionRollbackGate(true);
    } catch (error) {
      clearInterval(watchdog);
      await probePending;
      try {
        await this.enableProjectionRollbackGate();
      } finally {
        await this.stopRollbackServices();
      }
      throw error;
    } finally {
      clearInterval(watchdog);
    }
  }

  private async startOperation(
    phase: DruviaUpdateStatus['phase'],
    operation: (operationId: string) => Promise<void>,
    validateCurrent?: (current: DruviaUpdateStatus) => void,
    allowRollbackRecovery = false,
    rollbackBackupOperationId: string | null | ((current: DruviaUpdateStatus) => string | null | Promise<string | null>) = null
  ): Promise<UpdateOperationAccepted> {
    if (this.activeOperationId) throw new UpdateOperationInProgressError(this.activeOperationId);
    const operationId = this.operationIdFactory();
    this.activeOperationId = operationId;
    let status: DruviaUpdateStatus;
    try {
      const current = await this.getStatus();
      if (isDruviaUpdateMutatingPhase(current.phase)) {
        throw new UpdateOperationInProgressError(current.operationId);
      }
      if (!allowRollbackRecovery && current.error?.code === 'UPDATE_ROLLBACK_RECOVERY_REQUIRED') {
        throw new UpdatePreconditionError(
          'UPDATE_ROLLBACK_RECOVERY_REQUIRED', 'Rollback recovery must complete before another update operation'
        );
      }
      validateCurrent?.(current);
      const selectedRollbackBackupOperationId = typeof rollbackBackupOperationId === 'function'
        ? await rollbackBackupOperationId(current)
        : rollbackBackupOperationId;

      status = {
        ...current,
        phase,
        operationId,
        applyStage: phase === 'applying'
          ? allowRollbackRecovery ? 'rolling_back' : 'preparing_backup'
          : null,
        rollbackBackupOperationId: selectedRollbackBackupOperationId,
        startedAt: this.now().toISOString(),
        finishedAt: null,
        message: null,
        error: null,
      };
      await writeUpdateState(this.config.statePath, status);
    } catch (error) {
      this.activeOperationId = null;
      throw error;
    }

    this.backgroundRunner(async () => {
      try {
        await operation(operationId);
      } catch (error) {
        await this.handleOperationFailure(error);
      } finally {
        this.activeOperationId = null;
      }
    });

    return { operationId, status };
  }

  private async fetchReleaseManifest(): Promise<DruviaReleaseManifest> {
    const response = await this.fetchImpl(this.config.releaseManifestUrl);
    if (!response.ok) {
      throw new Error(`Release manifest request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const currentStatus = await this.getStatus();
    return validateReleaseManifest(payload, {
      currentVersion: currentStatus.currentVersion,
      currentUpdaterVersion: this.config.currentUpdaterVersion,
      channel: this.config.channel,
      allowedHosts: this.config.allowedHosts,
    });
  }

  private async downloadText(url: string): Promise<string> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Release asset request failed with HTTP ${response.status}`);
    }
    return response.text();
  }

  private async writeState(patch: Partial<DruviaUpdateStatus>): Promise<void> {
    const current = await this.getStatus();
    await writeUpdateState(this.config.statePath, {
      ...current,
      ...patch,
    });
  }

  private async handleOperationFailure(error: unknown): Promise<void> {
    const normalized = normalizeError(error);
    await this.writeState({
      phase: 'failed',
      finishedAt: this.now().toISOString(),
      message: normalized.message,
      error: normalized,
    });
  }

  private async createDatabaseBackup(backupDir: string): Promise<void> {
    const dumpPath = join(backupDir, 'postgres.dump');
    const command = buildPgDumpCommand(this.config.database, dumpPath);
    await this.runCommandImpl(command.command, command.args, { env: command.env });
    const sha256 = await sha256File(dumpPath);
    await fs.writeFile(`${dumpPath}.sha256`, `${sha256}\n`, 'utf8');
  }

  private async restoreBackup(backupDir: string): Promise<void> {
    await fs.copyFile(join(backupDir, '.env.release'), this.config.compose.releaseEnvFile);
    await fs.copyFile(join(backupDir, 'docker-compose.release.yml'), this.config.compose.composeFile);
    await syncReleaseFiles([this.config.compose.releaseEnvFile, this.config.compose.composeFile]);
  }

  private async assertRollbackBackupComplete(backupDir: string): Promise<void> {
    await fs.access(join(backupDir, '.env.release'));
    await fs.access(join(backupDir, 'docker-compose.release.yml'));
  }

  private buildAutomaticRollbackMessage(
    backupDir: string,
    manifest: DruviaReleaseManifest
  ): string {
    if (manifest.migrations.required && !manifest.migrations.reversible) {
      return `Rolled back release files using backup ${backupDir}; database migration may need manual restore from backup`;
    }
    return `Rolled back release files using backup ${backupDir}`;
  }

  private async pollHealthChecks(afterCheck?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.healthCheckTimeoutMs;
    let lastError: unknown = null;

    while (Date.now() <= deadline) {
      try {
        for (const url of this.config.healthCheckUrls) {
          const response = await this.fetchImpl(url, signal ? { signal } : undefined);
          if (!response.ok) {
            throw new Error(`Health check failed for ${url}: HTTP ${response.status}`);
          }
          await afterCheck?.();
        }
        await afterCheck?.();
        return;
      } catch (error) {
        if (afterCheck) await afterCheck();
        lastError = error;
        if (Date.now() + this.config.healthCheckIntervalMs > deadline) break;
        await this.sleep(this.config.healthCheckIntervalMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Health checks timed out');
  }

  private resolveBackupDir(operationId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(operationId)) {
      throw new UpdatePreconditionError('UPDATE_BACKUP_NOT_AVAILABLE', 'Invalid rollback backup identity');
    }
    return join(this.config.stateDir, 'backups', operationId);
  }
}
