import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/023_data_access_managed_policies.up.sql'
const downPath = 'migrations/023_data_access_managed_policies.down.sql'

describe('migration 023 managed data access policy contract', () => {
  it('creates baselines and persisted policy operations', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return
    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('CREATE TABLE druvia_data_access_managed_policies')
    expect(sql).toContain('column_grants JSONB NOT NULL')
    expect(sql).toContain('permissions_snapshot JSONB NOT NULL')
    expect(sql).toContain('revision BIGINT NOT NULL DEFAULT 1')
    expect(sql).toContain('PRIMARY KEY (project_id, schema_name, table_name)')
    expect(sql).toContain('CREATE TABLE druvia_data_access_policy_operations')
    expect(sql).toMatch(/CREATE TABLE druvia_data_access_policy_operations[\s\S]*schema_name VARCHAR\(128\) NOT NULL/)
    expect(sql).toContain('source_resource_version BIGINT NOT NULL')
    expect(sql).toContain('writer_epoch VARCHAR(64)')
    expect(sql).toContain('write_deadline_at TIMESTAMPTZ')
  })

  it('protects immutable operation payload and one active project operation', () => {
    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('protect_data_access_policy_operation_update')
    expect(sql).toContain('source_permissions IS DISTINCT FROM OLD.source_permissions')
    expect(sql).toContain('schema_name IS DISTINCT FROM OLD.schema_name')
    expect(sql).toContain('target_permissions IS DISTINCT FROM OLD.target_permissions')
    expect(sql).toContain('request_digest IS DISTINCT FROM OLD.request_digest')
    expect(sql).toContain('idx_data_access_policy_operations_active_project')
    expect(sql).toContain("status IN ('preview_ready', 'applying', 'recovering', 'recovery_required')")
  })

  it('guards deleting inflight operations and unsafe rollback', () => {
    const up = readFileSync(upPath, 'utf8')
    const down = readFileSync(downPath, 'utf8')
    expect(up).toContain('guard_data_access_policy_operation_delete')
    expect(up).toContain("ERRCODE = '55006'")
    expect(up).toContain("CONSTRAINT = 'druvia_data_access_policy_operations_inflight_delete_guard'")
    expect(down).toContain('druvia_data_access_managed_policies')
    expect(down).toContain('druvia_data_access_policy_operations')
    expect(down).toContain('LOCK TABLE druvia_data_access_managed_policies, druvia_data_access_policy_operations')
    expect(down).toContain('IN ACCESS EXCLUSIVE MODE')
    expect(down).toContain("ERRCODE = '55006'")
  })

  it('registers migration 023 with bootstrap detection', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    expect(runner).toContain("23: 'druvia_data_access_managed_policies'")
  })
})
