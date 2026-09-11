import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/026_project_device_wipe_mandates.up.sql'
const downPath = 'migrations/026_project_device_wipe_mandates.down.sql'

describe('migration 026 project device wipe contract', () => {
  it('persists config, signing keys, session-independent binding credentials and signed mandates', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('CREATE TABLE druvia_project_device_wipe_configs')
    expect(sql).toContain('binding_secret_verification CHAR(43)')
    expect(sql).toContain('credential_secret_verification CHAR(43)')
    expect(sql).toContain('CREATE TABLE druvia_project_device_wipe_signing_keys')
    expect(sql).toContain('CREATE TABLE druvia_project_device_wipe_bindings')
    expect(sql).toContain('CREATE TABLE druvia_project_device_wipe_mandates')
    expect(sql).toContain('lookup_token_hash CHAR(64)')
    expect(sql).toContain('project_user_id_encrypted TEXT NOT NULL')
    expect(sql).toContain('private_jwk_encrypted TEXT NOT NULL')
    expect(sql).toContain('command_json JSONB NOT NULL')
    expect(sql).toContain('receipt_digest CHAR(64)')
  })

  it('protects immutable commands and pending signing keys', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('guard_project_device_wipe_mandate_transition')
    expect(sql).toContain('project device wipe mandate identity is immutable')
    expect(sql).toContain('NEW.project_user_id_encrypted IS DISTINCT FROM OLD.project_user_id_encrypted')
    expect(sql).toMatch(
      /guard_project_device_wipe_binding_transition\(\)[\s\S]*NEW\.created_at IS DISTINCT FROM OLD\.created_at[\s\S]*project device wipe binding identity is immutable/,
    )
    expect(sql).toContain('guard_project_device_wipe_signing_key_retirement')
    expect(sql).toContain('cannot retire a project device wipe signing key with pending mandates')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('does not cascade device safety records when a project is deleted', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toMatch(/druvia_project_device_wipe_bindings[\s\S]*REFERENCES druvia_projects\(project_id\) ON DELETE RESTRICT/)
    expect(sql).toMatch(/druvia_project_device_wipe_mandates[\s\S]*FOREIGN KEY \(project_id, binding_id\)[\s\S]*REFERENCES druvia_project_device_wipe_bindings\(project_id, binding_id\) ON DELETE RESTRICT/)
  })

  it('refuses rollback while any device wipe state exists', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return

    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain('LOCK TABLE druvia_project_device_wipe_mandates IN ACCESS EXCLUSIVE MODE')
    expect(sql).toContain('cannot roll back migration 026 while project device wipe state exists')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('registers migration 026 as the bootstrap and release ceiling', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const generator = readFileSync('scripts/release/generate-manifest.mjs', 'utf8')

    expect(runner).toContain("26: 'druvia_project_device_wipe_mandates'")
    expect(workflow.match(/DRUVIA_MIGRATION_TO: '26'/g)).toHaveLength(2)
    expect(generator).toContain('const REQUIRED_MIGRATION_TARGET = 26')
  })
})
