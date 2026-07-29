import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultUpdateStatus,
  readUpdateState,
  writeUpdateState,
} from '../../apps/updater/src/state.js';

describe('updater state persistence', () => {
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
