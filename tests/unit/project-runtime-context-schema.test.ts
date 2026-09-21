import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/028_project_runtime_contexts.up.sql'
const downPath = 'migrations/028_project_runtime_contexts.down.sql'
const compatibilityUpPath = 'migrations/029_project_runtime_context_fences.up.sql'
const compatibilityDownPath = 'migrations/029_project_runtime_context_fences.down.sql'

describe('migration 028 project runtime context contract', () => {
  it('stores only a typed, versioned service environment per project', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('CREATE TABLE druvia_project_runtime_contexts')
    expect(sql).toContain('CREATE TABLE druvia_project_runtime_context_fences')
    expect(sql).toContain('project_id VARCHAR(64) PRIMARY KEY')
    expect(sql).toContain("service_environment IN ('local', 'sandbox', 'testflight', 'production')")
    expect(sql).toContain('revision BIGINT NOT NULL DEFAULT 1')
    expect(sql).toContain('CHECK (revision > 0)')
    expect(sql).toContain('updated_by VARCHAR(64)')
  })

  it('refuses rollback after a runtime context was enabled, even if later disabled', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return

    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain('cannot roll back migration 028 while project runtime context state exists')
    expect(sql).toContain('druvia_project_runtime_context_fences')
    expect(sql).toContain("ERRCODE = '55006'")
  })

  it('upgrades databases that applied the original migration 028 without fences', () => {
    expect(existsSync(compatibilityUpPath)).toBe(true)
    expect(existsSync(compatibilityDownPath)).toBe(true)
    if (!existsSync(compatibilityUpPath) || !existsSync(compatibilityDownPath)) return

    const up = readFileSync(compatibilityUpPath, 'utf8')
    const down = readFileSync(compatibilityDownPath, 'utf8')

    expect(up).toContain('CREATE TABLE IF NOT EXISTS druvia_project_runtime_context_fences')
    expect(up).toContain('INSERT INTO druvia_project_runtime_context_fences')
    expect(up).toContain('SELECT project_id, created_at')
    expect(up).toContain('FROM druvia_project_runtime_contexts')
    expect(up).toContain('ON CONFLICT (project_id) DO NOTHING')
    expect(down).toContain('cannot roll back migration 029 while project runtime context state exists')
    expect(down).toContain("ERRCODE = '55006'")
  })

  it('registers migration 029 as the API and release ceiling', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    const compatibility = readFileSync('apps/api/src/db/migration-compatibility.ts', 'utf8')
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const generator = readFileSync('scripts/release/generate-manifest.mjs', 'utf8')

    expect(runner).toContain("28: 'druvia_project_runtime_contexts'")
    expect(runner).toContain("29: 'druvia_project_runtime_context_fences'")
    expect(compatibility).toContain('API_SUPPORTED_MIGRATION_CEILING = 29')
    expect(compatibility).toContain('API_REQUIRED_MIGRATION_FLOOR = 29')
    expect(workflow.match(/DRUVIA_MIGRATION_TO: '29'/g)).toHaveLength(2)
    expect(generator).toContain('const REQUIRED_MIGRATION_TARGET = 29')
  })
})
