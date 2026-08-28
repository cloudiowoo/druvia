import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAppleProjectAuthSchema } from '../../apps/api/src/modules/auth-admin/apple-provider-config.js'

function migration(direction: 'up' | 'down') {
  return readFileSync(
    resolve(process.cwd(), `migrations/021_project_auth_identities.${direction}.sql`),
    'utf8'
  )
}

describe('Apple project auth migration 021', () => {
  it('creates identity, provider token and lifecycle event state', () => {
    const sql = migration('up')

    expect(sql).toContain('CREATE TABLE druvia_project_auth_identities')
    expect(sql).toContain('CREATE TABLE druvia_project_auth_provider_tokens')
    expect(sql).toContain('CREATE TABLE druvia_project_auth_events')
    expect(sql).toContain("'revoke_pending'")
    expect(sql).toContain("'deletion_pending'")
    expect(sql).toContain('UNIQUE (project_id, provider, issuer, subject)')
    expect(sql).toContain('UNIQUE (provider, issuer, event_id)')
  })

  it('binds only Apple project refresh tokens to identity and audience', () => {
    const sql = migration('up')

    expect(sql).toContain('ADD COLUMN identity_id BIGINT')
    expect(sql).toContain('ADD COLUMN provider_audience TEXT')
    expect(sql).toContain('druvia_project_refresh_tokens_apple_identity_check')
    expect(sql).toContain("provider <> 'apple'")
  })

  it('refuses down migration with lifecycle data and drops dependencies first', () => {
    const sql = migration('down')

    expect(sql).toContain('cannot roll back migration 021 while project auth state exists')
    expect(sql.indexOf('DROP CONSTRAINT IF EXISTS druvia_project_refresh_tokens_apple_identity_check'))
      .toBeLessThan(sql.indexOf('DROP TABLE druvia_project_auth_events'))
    expect(sql.indexOf('DROP TABLE druvia_project_auth_events'))
      .toBeLessThan(sql.indexOf('DROP TABLE druvia_project_auth_identities'))
  })
})

describe('Apple project schema preflight', () => {
  it('rejects a missing users table and a non-null provider_id column', () => {
    expect(() => validateAppleProjectAuthSchema([])).toThrow('users table')
    expect(() => validateAppleProjectAuthSchema([
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'provider_id', is_nullable: 'NO' },
    ])).toThrow('provider_id')
  })

  it('accepts the minimal users identity column', () => {
    expect(() => validateAppleProjectAuthSchema([
      { column_name: 'id', is_nullable: 'NO' },
    ])).not.toThrow()
  })
})
