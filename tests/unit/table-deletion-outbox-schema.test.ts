import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/024_table_deletion_outbox.up.sql'
const downPath = 'migrations/024_table_deletion_outbox.down.sql'

describe('migration 024 table deletion outbox contract', () => {
  it('persists retryable cross-system table deletions', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return
    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('CREATE TABLE druvia_table_deletion_outbox')
    expect(sql).toContain('operation_id VARCHAR(64) PRIMARY KEY')
    expect(sql).toContain('lock_scope VARCHAR(200) NOT NULL')
    expect(sql).toContain('UNIQUE (schema_name, table_name)')
    expect(sql).toContain("status VARCHAR(16) NOT NULL DEFAULT 'pending'")
    expect(sql).toContain('CREATE EVENT TRIGGER druvia_guard_pending_table_deletion_relation_reuse')
    expect(sql).toContain('pg_event_trigger_ddl_commands()')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('refuses rollback while a deletion still requires recovery', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return
    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain('LOCK TABLE druvia_table_deletion_outbox IN ACCESS EXCLUSIVE MODE')
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM druvia_table_deletion_outbox LIMIT 1)')
    expect(sql).toContain("ERRCODE = '55006'")
    expect(sql).toContain('DROP EVENT TRIGGER IF EXISTS druvia_guard_pending_table_deletion_relation_reuse')
  })

  it('registers migration 024 as the release ceiling', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const generator = readFileSync('scripts/release/generate-manifest.mjs', 'utf8')
    expect(runner).toContain("24: 'druvia_table_deletion_outbox'")
    expect(workflow.match(/DRUVIA_MIGRATION_TO: '24'/g)).toHaveLength(2)
    expect(generator).toContain('const REQUIRED_MIGRATION_TARGET = 24')
  })
})
