import { beforeEach, describe, expect, it, vi } from 'vitest';
const { client, storage, loadGuards, hook, journal } = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  storage: { name: 'local', delete: vi.fn(), exists: vi.fn() },
  loadGuards: vi.fn(), hook: vi.fn(), journal: vi.fn(),
}));
vi.mock('../../apps/api/src/db/index.js', () => ({ pool: { connect: vi.fn(async () => client) } }));
vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({ getDefaultStorageAdapter: () => storage }));
vi.mock('../../apps/api/src/modules/backup/project-backup-guard.js', () => ({
  loadProjectBackupGuards: loadGuards, executeProjectBackupGuard: hook, writeGuardJournal: journal,
  ProjectBackupGuardError: class extends Error {},
}));
import { deleteManagedBackupObject, runProjectBackupRetention, startProjectBackupRetention } from '../../apps/api/src/modules/backup/project-backup-retention.js';
const guard = { projectId: 'proj_one', schemaName: 'dru_one', retentionDays: 30 };
const row = { backup_id: 'bkp_fixture', tenant_id: 'tenant_one', project_id: 'proj_one', schema_name: 'dru_one', storage_key: 'backups/tenant_one/bkp_fixture.dump' };

describe('configured project backup retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadGuards.mockResolvedValue([guard]); storage.delete.mockResolvedValue(undefined); storage.exists.mockResolvedValue(false);
    hook.mockResolvedValue({ version: 1, schema: 'dru_one', fences: [] }); journal.mockResolvedValue(undefined);
    client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT b.backup_id') ? [row] : [] }));
  });
  it('keeps metadata on object deletion failure and does not renew the receiving lease', async () => {
    storage.delete.mockRejectedValue(new Error('private storage failure'));
    expect(await runProjectBackupRetention()).toEqual({ checked: 0, removed: 0, failed: 1 });
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM public.druvia_backups'))).toBe(false);
    expect(hook.mock.calls.some(([, , phase]) => phase === 'retention')).toBe(false);
  });
  it('verifies object absence before deleting metadata and exporting/renewing', async () => {
    expect(await runProjectBackupRetention()).toEqual({ checked: 1, removed: 1, failed: 0 });
    expect(storage.delete).toHaveBeenCalledWith(row.storage_key);
    expect(storage.exists).toHaveBeenCalledWith(row.storage_key);
    const metadataDelete = client.query.mock.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM public.druvia_backups'));
    expect(metadataDelete).toBeGreaterThan(0);
    expect(journal.mock.invocationCallOrder[0]).toBeLessThan(hook.mock.invocationCallOrder[1]);
    expect(hook).toHaveBeenLastCalledWith(client, guard, 'retention');
  });
  it('rejects still-present or noncanonical objects without deleting metadata', async () => {
    storage.exists.mockResolvedValue(true);
    await expect(deleteManagedBackupObject(client as never, row)).rejects.toThrow();
    await expect(deleteManagedBackupObject(client as never, { ...row, storage_key: '../secret' })).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
  it('retains registration and schema identity, bounds work and refuses a backlog lease', async () => {
    client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT b.backup_id') ? Array(26).fill(row) : [] }));
    expect((await runProjectBackupRetention()).failed).toBe(1);
    expect(storage.delete).toHaveBeenCalledTimes(25);
    expect(hook.mock.calls.some(([, , phase]) => phase === 'retention')).toBe(false);
    const sql = client.query.mock.calls.find(([sql]) => sql.includes('SELECT b.backup_id'))![0];
    expect(sql).toContain('b.schema_name=$2');
    expect(sql).toContain('b.project_id=$1 OR b.project_id IS NULL');
    expect(sql).toContain('LIMIT 26');
  });
  it('does nothing for unconfigured consumers and stops on journal failure', async () => {
    loadGuards.mockResolvedValue([]);
    expect(await runProjectBackupRetention()).toEqual({ checked: 0, removed: 0, failed: 0 });
    expect(client.query).not.toHaveBeenCalled();
    loadGuards.mockResolvedValue([guard]); journal.mockRejectedValue(new Error('disk unavailable'));
    expect((await runProjectBackupRetention()).failed).toBe(1);
    expect(hook.mock.calls.some(([, , phase]) => phase === 'retention')).toBe(false);
  });
});


describe('backup retention loop lifecycle', () => {
  it('starts immediately, avoids overlap and waits for an in-flight run when stopping', async () => {
    vi.useFakeTimers();
    let finish!: (value: { checked: number; removed: number; failed: number }) => void;
    const run = vi.fn(() => new Promise<{ checked: number; removed: number; failed: number }>(resolve => { finish = resolve; }));
    const stop = startProjectBackupRetention({ intervalMs: 1000, run });
    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(run).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish({ checked: 1, removed: 0, failed: 0 });
      await stopping;
      await vi.advanceTimersByTimeAsync(3000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
