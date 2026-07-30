import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUpdaterFinalizer } from '../../apps/updater/src/finalizer.js';
import type { CommandRunner } from '../../apps/updater/src/command.js';
import { writeUpdateState } from '../../apps/updater/src/state.js';

async function createStatePath() {
  const root = await mkdtemp(join(tmpdir(), 'druvia-updater-finalizer-'));
  const statePath = join(root, 'state', 'update-state.json');
  await mkdir(join(root, 'state'), { recursive: true });
  await writeUpdateState(statePath, {
    enabled: true,
    phase: 'finalizing',
    currentVersion: '0.2.0',
    availableVersion: null,
    channel: 'stable',
    releaseNotesUrl: null,
    migration: null,
    operationId: 'op-apply',
    startedAt: '2026-07-28T00:00:00.000Z',
    finishedAt: null,
    message: 'Updated to 0.2.0; updater finalizer scheduled',
    error: null,
  });
  return statePath;
}

async function readState(statePath: string) {
  return JSON.parse(await readFile(statePath, 'utf8')) as {
    phase: string;
    currentVersion: string;
    operationId: string | null;
    finishedAt: string | null;
    message: string | null;
    error: { code: string; message: string } | null;
  };
}

describe('updater finalizer', () => {
  it('replaces the updater and marks finalizer completion in shared state', async () => {
    const statePath = await createStatePath();
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      if (command === 'docker' && args[0] === 'inspect') {
        return { stdout: 'healthy\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    await runUpdaterFinalizer({
      delaySeconds: 0,
      statePath,
      targetVersion: '0.2.0',
      updaterContainerName: 'druvia-updater',
      composeCommand: ['docker', 'compose', 'up', '-d', 'updater'],
      runCommand: runner,
      sleep: async () => undefined,
      now: () => new Date('2026-07-28T00:01:00.000Z'),
    });

    expect(commands).toEqual([
      { command: 'docker', args: ['compose', 'up', '-d', 'updater'] },
      { command: 'docker', args: ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', 'druvia-updater'] },
    ]);
    await expect(readState(statePath)).resolves.toMatchObject({
      phase: 'succeeded',
      currentVersion: '0.2.0',
      operationId: null,
      finishedAt: '2026-07-28T00:01:00.000Z',
      message: 'Updated to 0.2.0; updater finalizer completed',
      error: null,
    });
  });

  it('keeps the core update succeeded but records finalizer failure in shared state', async () => {
    const statePath = await createStatePath();
    const runner: CommandRunner = async (command, args) => {
      if (command === 'docker' && args[0] === 'compose') throw new Error('compose failed');
      return { stdout: '', stderr: '' };
    };

    await expect(runUpdaterFinalizer({
      delaySeconds: 0,
      statePath,
      targetVersion: '0.2.0',
      updaterContainerName: 'druvia-updater',
      composeCommand: ['docker', 'compose', 'up', '-d', 'updater'],
      runCommand: runner,
      sleep: async () => undefined,
      now: () => new Date('2026-07-28T00:02:00.000Z'),
    })).rejects.toThrow('compose failed');

    await expect(readState(statePath)).resolves.toMatchObject({
      phase: 'succeeded',
      currentVersion: '0.2.0',
      operationId: null,
      finishedAt: '2026-07-28T00:02:00.000Z',
      message: 'Updated to 0.2.0; updater finalizer failed: compose failed',
      error: null,
    });
  });

  it('waits until the replacement updater reports healthy before marking completion', async () => {
    const statePath = await createStatePath();
    const inspectResults = ['starting\n', 'healthy\n'];
    const runner: CommandRunner = async (command, args) => {
      if (command === 'docker' && args[0] === 'inspect') {
        return { stdout: inspectResults.shift() ?? 'healthy\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    let sleeps = 0;

    await runUpdaterFinalizer({
      delaySeconds: 0,
      statePath,
      targetVersion: '0.2.0',
      updaterContainerName: 'druvia-updater',
      composeCommand: ['docker', 'compose', 'up', '-d', 'updater'],
      runCommand: runner,
      sleep: async () => {
        sleeps += 1;
      },
      now: () => new Date('2026-07-28T00:04:00.000Z'),
      healthCheckIntervalMs: 100,
      healthCheckTimeoutMs: 1_000,
    });

    expect(sleeps).toBe(1);
    await expect(readState(statePath)).resolves.toMatchObject({
      phase: 'succeeded',
      message: 'Updated to 0.2.0; updater finalizer completed',
    });
  });

  it('creates a fallback state file when the current state is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'druvia-updater-finalizer-missing-'));
    const statePath = join(root, 'state', 'update-state.json');

    await runUpdaterFinalizer({
      delaySeconds: 0,
      statePath,
      targetVersion: '0.2.0',
      updaterContainerName: 'druvia-updater',
      composeCommand: ['docker', 'compose', 'up', '-d', 'updater'],
      runCommand: async (command, args) => {
        if (command === 'docker' && args[0] === 'inspect') return { stdout: 'healthy\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-28T00:03:00.000Z'),
    });

    await expect(readFile(statePath, 'utf8')).resolves.toContain('updater finalizer completed');
  });
});
