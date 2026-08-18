import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { queryOne } from '../../apps/api/src/db/index.js'
import {
  createMigrationPreview,
  getLatestProjectMigration,
  getProjectMigration,
  setProjectDataAccessMode,
  transitionMigration,
} from '../../apps/api/src/modules/data-access/data-access-migration.repository.js'

const row = {
  migration_id: 'mig_1', project_id: 'proj_1', status: 'preview_ready', phase: 'preview',
  source_snapshot: { projectId: 'proj_1' }, migration_plan: { version: 1 }, source_digest: 'a'.repeat(64),
  applied_snapshot: null, applied_digest: null, rollback_preview_digest: null, recovery_target: null,
  has_destructive_changes: false, created_by: 'usr_1', error_code: null, error_message: null,
  created_at: new Date('2026-08-18T00:00:00Z'), started_at: null, applied_at: null,
  completed_at: null, updated_at: new Date('2026-08-18T00:00:00Z'),
}

describe('data access migration repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(queryOne).mockResolvedValue(row as never)
  })

  it('persists an immutable preview payload', async () => {
    const result = await createMigrationPreview({
      migrationId: 'mig_1', projectId: 'proj_1', sourceSnapshot: row.source_snapshot as never,
      migrationPlan: row.migration_plan as never, sourceDigest: row.source_digest,
      hasDestructiveChanges: false, createdBy: 'usr_1',
    })

    expect(queryOne).toHaveBeenCalledWith(expect.stringMatching(/'preview_ready', 'preview'/), [
      'mig_1', 'proj_1', JSON.stringify(row.source_snapshot), JSON.stringify(row.migration_plan),
      row.source_digest, false, 'usr_1',
    ])
    expect(result.migrationId).toBe('mig_1')
  })

  it('loads latest and project-scoped migration records', async () => {
    await getLatestProjectMigration('proj_1')
    expect(queryOne).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY created_at DESC, id DESC'), ['proj_1'])

    await getProjectMigration('proj_1', 'mig_1')
    expect(queryOne).toHaveBeenLastCalledWith(expect.stringContaining('migration_id = $2'), ['proj_1', 'mig_1'])
  })

  it('uses guarded expected-status transitions and serializes snapshots', async () => {
    await transitionMigration('mig_1', ['applying'], {
      status: 'applied', phase: 'completed', recoveryTarget: null,
      appliedSnapshot: row.source_snapshot as never, appliedDigest: 'b'.repeat(64),
      appliedAt: new Date('2026-08-18T01:00:00Z'), completedAt: new Date('2026-08-18T01:00:00Z'),
    })

    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('status = ANY'),
      expect.arrayContaining(['mig_1', ['applying'], 'applied', 'completed', JSON.stringify(row.source_snapshot)]),
    )
  })

  it('updates runtime mode through one guarded project row', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ project_id: 'proj_1' } as never)
    await expect(setProjectDataAccessMode('proj_1', 'compatibility', 'explicit')).resolves.toBe(true)
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('data_access_mode = $2'), [
      'proj_1', 'explicit', 'compatibility',
    ])
  })
})
