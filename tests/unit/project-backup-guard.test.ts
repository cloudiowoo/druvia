import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectBackupGuards, executeProjectBackupGuard, writeGuardJournal } from '../../apps/api/src/modules/backup/project-backup-guard.js';

const guard = {
  projectId: 'proj_fixture', schemaName: 'dru_fixture', hookSchema: 'private_guard',
  hookName: 'restore_v1', hookOwner: 'guard_owner', hookHash: 'a'.repeat(64),
  retentionDays: 30, journalDirectory: '/tmp/guard-fixture',
};

describe('configured project backup guard', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts explicit bounded contracts and rejects ambiguous or unsafe configuration', () => {
    expect(parseProjectBackupGuards({ version: 1, projects: [guard] })).toEqual([guard]);
    for (const bad of [
      { ...guard, retentionDays: 31 }, { ...guard, hookName: 'x;DROP' },
      { ...guard, journalDirectory: 'relative' }, { ...guard, hookHash: '' },
    ]) expect(() => parseProjectBackupGuards({ version: 1, projects: [bad] })).toThrow();
    expect(() => parseProjectBackupGuards({ version: 1, projects: [guard, guard] })).toThrow();
  });
  it('pins owner, signature and function hash in the statement that executes the hook', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ result: { completed: true } }] }) };
    await executeProjectBackupGuard(client as never, guard, 'replay');
    const [sql, params] = client.query.mock.calls[1]!;
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('CASE WHEN EXISTS');
    expect(sql).toContain('"private_guard"."restore_v1"($1::text)');
    expect(sql).toContain('pg_auth_members');
    expect(params).toContain(guard.hookHash);
    expect(params).toContain(guard.projectId);
  });
  it('fails closed on contract drift or SQL failure without exposing SQL details', async () => {
    for (const result of [null, { completed: false }]) {
      const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ result }] }) };
      await expect(executeProjectBackupGuard(client as never, guard, 'replay')).rejects.toMatchObject({ code: 'PROJECT_BACKUP_GUARD_REQUIRED' });
    }
    const client = { query: vi.fn().mockRejectedValue(new Error('private SQL and payload')) };
    await expect(executeProjectBackupGuard(client as never, guard, 'prepare')).rejects.toThrow('Project backup protection is unavailable');
  });
  it('atomically writes only validated minimal receipts with private permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'druvia-guard-'));
    try {
      const configured = { ...guard, journalDirectory: dir };
      const journal = { version: 1, schema: guard.schemaName, fences: [
        { id: '11111111-1111-4111-8111-111111111111', state: 'withdrawn', createdAt: '2026-11-18T00:00:00Z' },
      ] };
      await writeFile(join(dir, `${guard.projectId}.json`), JSON.stringify({ version: 1, schema: guard.schemaName, fences: [] }), { mode: 0o600 });
      await writeGuardJournal(configured, journal);
      const file = join(dir, `${guard.projectId}.json`);
      expect(JSON.parse(await readFile(file, 'utf8')).fences).toEqual(journal.fences);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await writeGuardJournal(configured, { ...journal, fences: [] });
      expect(JSON.parse(await readFile(file, 'utf8')).fences).toEqual(journal.fences);
      await expect(writeGuardJournal(configured, { ...journal, packageBase64: 'sensitive' })).rejects.toThrow();
      expect(JSON.parse(await readFile(file, 'utf8')).fences).toEqual(journal.fences);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
