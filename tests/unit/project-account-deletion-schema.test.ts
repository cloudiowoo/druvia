import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/025_project_account_deletions.up.sql'
const downPath = 'migrations/025_project_account_deletions.down.sql'

describe('migration 025 project account deletion contract', () => {
  it('persists deletion operations, fences, provider material, restore gates and executor heartbeats', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('ADD COLUMN generation INTEGER NOT NULL DEFAULT 1')
    expect(sql).toContain('CREATE TABLE druvia_project_account_deletion_configs')
    expect(sql).toContain('CREATE TABLE druvia_project_account_deletions')
    expect(sql).toContain('CREATE TABLE druvia_project_account_deletion_fences')
    expect(sql).toContain('CREATE TABLE druvia_project_account_deletion_provider_tokens')
    expect(sql).toContain('CREATE TABLE druvia_project_runtime_gates')
    expect(sql).toContain('CREATE TABLE druvia_account_deletion_executor_heartbeats')
  })

  it('constrains state transitions and idempotent active operations', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain("status IN ('pending_confirmation', 'expired', 'accepted', 'processing', 'attention_required', 'completed')")
    expect(sql).toContain("source IN ('project_user', 'apple_notification')")
    expect(sql).toContain('idx_project_account_deletions_active_user')
    expect(sql).toContain("WHERE status NOT IN ('expired', 'completed')")
    expect(sql).toContain('idx_project_account_deletions_source_reference')
    expect(sql).toContain('guard_project_account_deletion_transition')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('refuses rollback after an account deletion has been accepted', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return

    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain('LOCK TABLE druvia_project_account_deletions IN ACCESS EXCLUSIVE MODE')
    expect(sql).toContain("status IN ('accepted', 'processing', 'attention_required', 'completed')")
    expect(sql).toContain('cannot roll back migration 025 while project account deletion state exists')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('keeps migration 025 registered after later release migrations', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')

    expect(runner).toContain("25: 'druvia_project_account_deletions'")
  })
})
