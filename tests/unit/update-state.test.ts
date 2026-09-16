import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultUpdateStatus,
  readUpdateState,
  writeUpdateState,
} from '../../apps/updater/src/state.js';

describe('updater state persistence', () => {
  it('syncs the temp state and its parent directory before acknowledging a transition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'druvia-durable-state-'));
    const statePath = join(dir, 'update-state.json');
    const synced: string[] = [];
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        synced.push(String(args[0]));
        await originalSync();
      });
      return handle;
    });
    try {
      await writeUpdateState(statePath, createDefaultUpdateStatus({ currentVersion: '0.2.0', channel: 'stable' }));
      expect(synced).toEqual([`${statePath}.tmp`, dir]);
    } finally {
      open.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips update state with an atomic temp file cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'druvia-update-state-'));
    const statePath = join(dir, 'update-state.json');

    try {
      const state = {
        ...createDefaultUpdateStatus({ currentVersion: '0.1.0', channel: 'stable' }),
        phase: 'ready_to_apply' as const,
        availableVersion: '0.2.0',
        operationId: 'op_123',
      };

      await writeUpdateState(statePath, state);

      expect(await readUpdateState(statePath, createDefaultUpdateStatus({ currentVersion: '0.1.0', channel: 'stable' })))
        .toEqual(state);
      expect(existsSync(`${statePath}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the fallback state when no persisted state exists', async () => {
    const fallback = createDefaultUpdateStatus({ currentVersion: '0.1.0', channel: 'stable' });

    await expect(readUpdateState('/tmp/druvia-missing-update-state.json', fallback)).resolves.toEqual(fallback);
  });
});
