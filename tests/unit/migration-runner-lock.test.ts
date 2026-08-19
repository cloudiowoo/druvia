import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'apps/api/src/cli/migrate.ts'), 'utf8')

describe('migration runner session lock contract', () => {
  it('uses a checked-out client for lock, migration work and unlock', () => {
    expect(source).toContain('const client = await pool.connect()')
    expect(source).toContain("client.query('SELECT pg_try_advisory_lock")
    expect(source).toContain("client.query('SELECT pg_advisory_unlock")
    expect(source).not.toContain("process.exit(1)")
  })

  it('strips migration-owned transaction wrappers before runner transactions', () => {
    expect(source).toContain('stripMigrationTransactionWrapper')
    expect(source).toContain("await client.query('BEGIN')")
    expect(source).toContain("await client.query('ROLLBACK')")
  })

  it('detects an already provisioned migration 020 during bootstrap', () => {
    expect(source).toContain("13: 'druvia_refresh_tokens'")
    expect(source).toContain("16: 'druvia_project_refresh_tokens'")
    expect(source).toContain("17: 'druvia_trusted_backend_keys'")
    expect(source).toContain("column_name = 'project_user_access'")
    expect(source).toContain("column_name = 'owner_project_user_id'")
    expect(source).toMatch(/20:\s*`SELECT EXISTS/)
  })
})
