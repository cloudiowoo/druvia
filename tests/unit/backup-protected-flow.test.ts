import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { row, queryOne, lockClient, storage, guards, hook, replay, mark, timeline } = vi.hoisted(() => ({
  row: { id: 1, backup_id: 'bkp_1', tenant_id: 'tenant_one', project_id: 'proj_one', schema_name: 'dru_one', storage_key: 'backups/tenant_one/bkp_1.dump', size_bytes: 1, tables_count: 1, tables_list: [], status: 'completed', error_message: null, created_by: 1, created_at: new Date(), completed_at: new Date() },
  queryOne: vi.fn(), lockClient: { query: vi.fn(), release: vi.fn() },
  storage: { name: 'local', read: vi.fn(), delete: vi.fn(), exists: vi.fn() },
  guards: vi.fn(), hook: vi.fn(), replay: vi.fn(), mark: vi.fn(), timeline: [] as string[],
}));
vi.mock('../../apps/api/src/db/index.js', () => ({ query: vi.fn(), queryOne, pool: { connect: async () => lockClient } }));
vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({ getDefaultStorageAdapter: () => storage }));
vi.mock('../../apps/api/src/modules/backup/project-backup-guard.js', () => ({
  loadProjectBackupGuards: guards, executeProjectBackupGuard: hook, writeGuardJournal: vi.fn(),
  ProjectBackupGuardError: class extends Error { code = 'PROJECT_BACKUP_GUARD_REQUIRED'; },
}));
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: async (_: unknown, fn: (client: unknown) => unknown) => fn(lockClient),
}));
vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({ withProjectAuthProjectLock: async (_: unknown, __: unknown, fn: () => unknown) => fn() }));
vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion-restore.service.js', () => ({
  beginProjectRestoreGate: async () => { timeline.push('gate'); }, replayProjectAccountDeletionFences: replay, markProjectRestoreRecoveryRequired: mark,
}));
vi.mock('child_process', () => ({ spawn: () => {
  const child = new EventEmitter() as EventEmitter & { stdin: { write: () => void; end: () => void }; stderr: EventEmitter; stdout: EventEmitter };
  child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
  child.stdin = { write: () => {}, end: () => { timeline.push('restore'); queueMicrotask(() => child.emit('close', 0)); } };
  return child;
} }));
import { restoreBackup, deleteBackup, getBackupDownloadUrl } from '../../apps/api/src/modules/backup/backup.service.js';
const guard = { projectId: 'proj_one', schemaName: 'dru_one', retentionDays: 30 };

describe('guarded backup restore orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks(); timeline.length = 0;
    queryOne.mockResolvedValue(row); guards.mockResolvedValue([guard]); lockClient.query.mockResolvedValue({ rows: [] });
    storage.read.mockResolvedValue(Buffer.from('synthetic-dump')); storage.delete.mockResolvedValue(undefined); storage.exists.mockResolvedValue(false);
    hook.mockImplementation(async (_: unknown, __: unknown, phase: string) => { timeline.push(phase); return { completed: true }; });
    replay.mockImplementation(async (_: unknown, __: unknown, callbacks: { beforeReplay: (c: unknown) => unknown; afterReplay: (c: unknown) => unknown }) => {
      await callbacks.beforeReplay(lockClient); timeline.push('account-device'); await callbacks.afterReplay(lockClient); timeline.push('clear-gate');
    });
  });
  it('prepares before restore and reapplies diagnostics after account/device replay before reopening', async () => {
    await restoreBackup('bkp_1');
    expect(timeline).toEqual(['gate', 'prepare', 'restore', 'beginReplay', 'account-device', 'replay', 'clear-gate']);
    expect(mark).not.toHaveBeenCalled();
  });
  it('never restores or clears the gate after preparation fails', async () => {
    hook.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'PROJECT_BACKUP_GUARD_REQUIRED' }));
    await expect(restoreBackup('bkp_1')).rejects.toThrow('unavailable');
    expect(storage.read).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith('proj_one', 'bkp_1', 'PROJECT_BACKUP_GUARD_REQUIRED');
  });
  it('rechecks the row after taking the backup lock and rejects expired downloads', async () => {
    queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    await expect(restoreBackup('bkp_1')).rejects.toThrow();
    expect(timeline).toEqual([]);
    queryOne.mockResolvedValue({ ...row, created_at: new Date(0) });
    await expect(getBackupDownloadUrl('bkp_1')).resolves.toBeNull();
  });
  it('manual protected deletion retains metadata when storage fails', async () => {
    storage.delete.mockRejectedValue(new Error('storage failure'));
    await expect(deleteBackup('bkp_1')).rejects.toThrow('storage failure');
    expect(lockClient.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM public.druvia_backups'))).toBe(false);
  });
});
