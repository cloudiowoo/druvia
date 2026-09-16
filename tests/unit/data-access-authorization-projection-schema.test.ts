import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/027_data_access_authorization_projections.up.sql'
const downPath = 'migrations/027_data_access_authorization_projections.down.sql'

describe('migration 027 data access authorization projections', () => {
  it('extends baselines and persists project-level atomic operations', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return
    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('dependency_snapshot JSONB')
    expect(sql).toContain('dependency_digest CHAR(64)')
    expect(sql).toContain('policy_version IN (1, 2)')
    expect(sql).toContain('CREATE TABLE druvia_data_access_projection_operations')
    expect(sql).toContain('CREATE TABLE druvia_data_access_runtime_gates')
    expect(sql).toContain("CHECK (gate_name IN ('file_rollback'))")
    expect(sql).toContain('baseline_revisions JSONB NOT NULL')
    expect(sql).toContain('source_metadata JSONB NOT NULL')
    expect(sql).toContain('target_metadata JSONB NOT NULL')
    expect(sql).toContain('writer_epoch VARCHAR(64)')
    expect(sql).toContain('write_deadline_at TIMESTAMPTZ')
  })

  it('protects immutable operation payload and unsafe rollback', () => {
    const up = readFileSync(upPath, 'utf8')
    const down = readFileSync(downPath, 'utf8')
    expect(up).toContain('protect_data_access_projection_operation_update')
    expect(up).toContain('idx_data_access_projection_operations_active_project')
    expect(up).toContain('druvia_data_access_projection_operations_inflight_delete_guard')
    expect(down).toContain('cannot roll back migration 027 while projection state exists')
    expect(down).toContain('cannot roll back migration 027 while a data access runtime gate is active')
    expect(down).toContain("ERRCODE = '55006'")
  })

  it('registers migration 027 as the release ceiling', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    expect(runner).toContain("27: 'druvia_data_access_projection_operations'")
  })
})
