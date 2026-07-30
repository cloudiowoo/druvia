import { pathToFileURL } from 'node:url';
import type { DruviaUpdateStatus } from '@druvia/shared';
import { runCommand, type CommandRunner } from './command.js';
import { createDefaultUpdateStatus, readUpdateState, writeUpdateState } from './state.js';

export interface UpdaterFinalizerInput {
  delaySeconds: number;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  statePath: string;
  targetVersion: string;
  updaterContainerName: string;
  composeCommand: string[];
  runCommand?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readState(statePath: string, targetVersion: string): Promise<DruviaUpdateStatus> {
  return readUpdateState(statePath, createDefaultUpdateStatus({
    currentVersion: targetVersion,
    channel: 'stable',
  }));
}

async function patchState(
  statePath: string,
  targetVersion: string,
  patch: Partial<DruviaUpdateStatus>
): Promise<void> {
  const current = await readState(statePath, targetVersion);
  await writeUpdateState(statePath, {
    ...current,
    ...patch,
  });
}

async function waitForUpdaterHealthy(input: {
  intervalMs: number;
  run: CommandRunner;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  updaterContainerName: string;
}): Promise<void> {
  let elapsedMs = 0;
  let lastStatus = 'unknown';

  while (elapsedMs <= input.timeoutMs) {
    try {
      const result = await input.run('docker', [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        input.updaterContainerName,
      ]);
      lastStatus = result.stdout.trim() || 'unknown';
      if (lastStatus === 'healthy' || lastStatus === 'running') return;
    } catch (error) {
      lastStatus = normalizeErrorMessage(error);
    }

    if (elapsedMs >= input.timeoutMs) break;
    await input.sleep(input.intervalMs);
    elapsedMs += input.intervalMs;
  }

  throw new Error(`replacement updater did not become healthy within ${input.timeoutMs}ms: ${lastStatus}`);
}

export async function runUpdaterFinalizer(input: UpdaterFinalizerInput): Promise<void> {
  const run = input.runCommand ?? runCommand;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const now = input.now ?? (() => new Date());
  const [composeCommand, ...composeArgs] = input.composeCommand;
  if (!composeCommand) throw new Error('Finalizer compose command is required');

  await patchState(input.statePath, input.targetVersion, {
    phase: 'finalizing',
    currentVersion: input.targetVersion,
    availableVersion: null,
    finishedAt: null,
    message: `Updated to ${input.targetVersion}; updater finalizer running`,
    error: null,
  });

  try {
    if (input.delaySeconds > 0) {
      await sleep(input.delaySeconds * 1000);
    }
    await run(composeCommand, composeArgs);
    await waitForUpdaterHealthy({
      intervalMs: input.healthCheckIntervalMs ?? 2_000,
      run,
      sleep,
      timeoutMs: input.healthCheckTimeoutMs ?? 120_000,
      updaterContainerName: input.updaterContainerName,
    });
    await patchState(input.statePath, input.targetVersion, {
      phase: 'succeeded',
      currentVersion: input.targetVersion,
      availableVersion: null,
      operationId: null,
      finishedAt: now().toISOString(),
      message: `Updated to ${input.targetVersion}; updater finalizer completed`,
      error: null,
    });
  } catch (error) {
    await patchState(input.statePath, input.targetVersion, {
      phase: 'succeeded',
      currentVersion: input.targetVersion,
      availableVersion: null,
      operationId: null,
      finishedAt: now().toISOString(),
      message: `Updated to ${input.targetVersion}; updater finalizer failed: ${normalizeErrorMessage(error)}`,
      error: null,
    });
    throw error;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseDelaySeconds(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid DRUVIA_FINALIZER_DELAY_SECONDS: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const separatorIndex = process.argv.indexOf('--');
  const composeCommand = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];
  await runUpdaterFinalizer({
    delaySeconds: parseDelaySeconds(process.env.DRUVIA_FINALIZER_DELAY_SECONDS),
    statePath: requiredEnv('DRUVIA_FINALIZER_STATE_PATH'),
    targetVersion: requiredEnv('DRUVIA_FINALIZER_TARGET_VERSION'),
    updaterContainerName: requiredEnv('DRUVIA_FINALIZER_UPDATER_CONTAINER_NAME'),
    composeCommand,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(normalizeErrorMessage(error));
    process.exitCode = 1;
  });
}
