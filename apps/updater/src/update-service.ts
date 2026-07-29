import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DruviaReleaseManifest, DruviaUpdateStatus } from '@druvia/shared';
import { isDruviaUpdateMutatingPhase } from '@druvia/shared';
import { runCommand, type CommandRunner } from './command.js';
import type { UpdaterConfig } from './config.js';
import { buildComposeArgs, buildDockerImagePullArgs } from './compose.js';
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

export class UpdateService implements UpdateRouteService {
  private activeOperationId: string | null = null;
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
    return readUpdateState(
      this.config.statePath,
      createDefaultUpdateStatus({
        currentVersion: this.config.currentVersion,
        channel: this.config.channel,
      })
    );
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
      const manifest = await readJsonFile<DruviaReleaseManifest>(this.config.stagedManifestPath);
      await fs.access(this.config.stagedReleaseEnvPath);
      await fs.access(this.config.stagedComposePath);

      const backupDir = join(this.config.stateDir, 'backups', operationId);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(this.config.compose.releaseEnvFile, join(backupDir, '.env.release'));
      await fs.copyFile(this.config.compose.composeFile, join(backupDir, 'docker-compose.release.yml'));

      if (manifest.migrations.requiresBackup) {
        await this.createDatabaseBackup(backupDir);
      }

      let releaseFilesSwitched = false;
      try {
        await fs.rename(this.config.stagedComposePath, this.config.compose.composeFile);
        releaseFilesSwitched = true;
        await fs.rename(this.config.stagedReleaseEnvPath, this.config.compose.releaseEnvFile);

        if (manifest.migrations.required) {
          await this.runCommandImpl('docker', buildComposeArgs('migrate', this.config.compose));
        }
        await this.runCommandImpl('docker', buildComposeArgs('up', this.config.compose));
        await this.writeState({ phase: 'verifying', message: 'Verifying services after update' });
        await this.pollHealthChecks();
      } catch (error) {
        if (!releaseFilesSwitched) throw error;

        await this.restoreBackup(backupDir);
        await this.runCommandImpl('docker', buildComposeArgs('rollbackUp', this.config.compose));
        await this.writeState({ phase: 'verifying', message: 'Verifying services after rollback' });
        await this.pollHealthChecks();

        const normalized = normalizeError(error);
        await this.writeState({
          phase: 'rolled_back',
          availableVersion: null,
          finishedAt: this.now().toISOString(),
          message: this.buildAutomaticRollbackMessage(backupDir, manifest),
          error: normalized,
          operationId: null,
        });
        return;
      }

      await this.writeState({
        phase: 'succeeded',
        currentVersion: manifest.version,
        availableVersion: null,
        releaseNotesUrl: manifest.releaseNotesUrl,
        migration: manifest.migrations,
        finishedAt: this.now().toISOString(),
        message: `Updated to ${manifest.version}`,
        operationId: null,
      });

      try {
        await this.runCommandImpl('docker', buildComposeArgs('selfUpdate', this.config.compose));
      } catch {
        await this.writeState({
          message: `Updated to ${manifest.version}; updater self-update failed and can be retried manually`,
        });
      }
    }, (current) => {
      if (current.phase !== 'ready_to_apply') {
        throw new UpdatePreconditionError('UPDATE_NOT_READY', 'No downloaded update is ready to apply');
      }
    });
  }

  async rollbackUpdate(): Promise<UpdateOperationAccepted> {
    const statusBeforeRollback = await this.getStatus();
    const backupOperationId = statusBeforeRollback.operationId;

    return this.startOperation('applying', async () => {
      try {
        const backupDir = await this.resolveBackupDir(backupOperationId);
        await this.restoreBackup(backupDir);
        await this.runCommandImpl('docker', buildComposeArgs('rollbackUp', this.config.compose));
        await this.writeState({ phase: 'verifying', message: 'Verifying services after rollback' });
        await this.pollHealthChecks();
        await this.writeState({
          phase: 'rolled_back',
          availableVersion: null,
          operationId: null,
          finishedAt: this.now().toISOString(),
          message: `Rolled back using backup ${backupDir}`,
          error: null,
        });
      } catch (error) {
        await this.writeState({ operationId: backupOperationId });
        throw error;
      }
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

  private async startOperation(
    phase: DruviaUpdateStatus['phase'],
    operation: (operationId: string) => Promise<void>,
    validateCurrent?: (current: DruviaUpdateStatus) => void
  ): Promise<UpdateOperationAccepted> {
    const current = await this.getStatus();
    if (this.activeOperationId || isDruviaUpdateMutatingPhase(current.phase)) {
      throw new UpdateOperationInProgressError(this.activeOperationId ?? current.operationId);
    }
    validateCurrent?.(current);

    const operationId = this.operationIdFactory();
    const status: DruviaUpdateStatus = {
      ...current,
      phase,
      operationId,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      message: null,
      error: null,
    };
    await writeUpdateState(this.config.statePath, status);
    this.activeOperationId = operationId;

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

  private async pollHealthChecks(): Promise<void> {
    const deadline = Date.now() + this.config.healthCheckTimeoutMs;
    let lastError: unknown = null;

    while (Date.now() <= deadline) {
      try {
        for (const url of this.config.healthCheckUrls) {
          const response = await this.fetchImpl(url);
          if (!response.ok) {
            throw new Error(`Health check failed for ${url}: HTTP ${response.status}`);
          }
        }
        return;
      } catch (error) {
        lastError = error;
        if (Date.now() + this.config.healthCheckIntervalMs > deadline) break;
        await this.sleep(this.config.healthCheckIntervalMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Health checks timed out');
  }

  private async resolveBackupDir(operationId: string | null): Promise<string> {
    if (operationId) {
      return join(this.config.stateDir, 'backups', operationId);
    }

    const backupsRoot = join(this.config.stateDir, 'backups');
    const entries = await fs.readdir(backupsRoot, { withFileTypes: true });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(backupsRoot, entry.name);
          const stat = await fs.stat(path);
          return { path, mtimeMs: stat.mtimeMs };
        })
    );
    directories.sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (!directories[0]) {
      throw new Error('No update backup is available for rollback');
    }
    return directories[0].path;
  }
}
