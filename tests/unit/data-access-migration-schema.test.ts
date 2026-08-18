import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/019_data_access_migrations.up.sql'
const downPath = 'migrations/019_data_access_migrations.down.sql'

describe('data access migration schema', () => {
  it('creates the persisted migration state and recovery constraints', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('CREATE TABLE druvia_data_access_migrations')
    expect(sql).toContain('source_snapshot JSONB NOT NULL')
    expect(sql).toContain('migration_plan JSONB NOT NULL')
    expect(sql).toContain('source_digest CHAR(64) NOT NULL')
    expect(sql).toContain('applied_snapshot JSONB')
    expect(sql).toContain('applied_digest CHAR(64)')
    expect(sql).toContain('applied_at TIMESTAMPTZ')
    expect(sql).toContain("recovery_target IN ('source', 'applied')")
    expect(sql).toContain("'recovered'")
    expect(sql).toContain("'restore_runtime_mode'")
    expect(sql).toContain("'verify_recovery_target'")
    expect(sql).toContain('REFERENCES druvia_projects(project_id) ON DELETE CASCADE')
  })

  it('protects immutable payloads and guarded state transitions', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('protect_data_access_migration_update')
    expect(sql).toContain('source_snapshot IS DISTINCT FROM OLD.source_snapshot')
    expect(sql).toContain('migration_plan IS DISTINCT FROM OLD.migration_plan')
    expect(sql).toContain('source_digest IS DISTINCT FROM OLD.source_digest')
    expect(sql).toContain("OLD.status = 'applying' AND NEW.status = 'applied'")
    expect(sql).toContain('applied_snapshot IS DISTINCT FROM OLD.applied_snapshot')
    expect(sql).toContain('applied_digest IS DISTINCT FROM OLD.applied_digest')
    expect(sql).toContain('applied_at IS DISTINCT FROM OLD.applied_at')
    expect(sql).toContain("NEW.recovery_target IS DISTINCT FROM 'source'")
    expect(sql).toContain("NEW.recovery_target IS DISTINCT FROM 'applied'")
    expect(sql).toContain('NEW.updated_at := NOW()')
  })

  it('guards active records and rollback candidates', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('idx_data_access_migrations_active_operation')
    expect(sql).toContain("status IN ('preview_ready', 'applying', 'rolling_back')")
    expect(sql).toContain("'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'")
    expect(sql).toContain("'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'")
    expect(sql).toContain('idx_data_access_migrations_rollback_candidate')
    expect(sql).toContain("WHERE status = 'applied'")
    expect(sql).toContain('guard_data_access_migration_delete')
    expect(sql).toContain("ERRCODE = '55006'")
    expect(sql).toContain("CONSTRAINT = 'druvia_data_access_migrations_inflight_delete_guard'")
  })

  it('refuses unsafe rollback and removes all migration objects', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return

    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain("status IN ('applying', 'rolling_back', 'applied')")
    expect(sql).toContain("'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'")
    expect(sql).toContain("'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'")
    expect(sql).toContain('DROP TRIGGER')
    expect(sql).toContain('DROP FUNCTION')
    expect(sql).toContain('DROP TABLE druvia_data_access_migrations')
  })

  it('detects migration 019 during bootstrap', () => {
    const source = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    expect(source).toContain("19: 'druvia_data_access_migrations'")
  })
})
