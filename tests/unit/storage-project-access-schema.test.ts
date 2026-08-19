import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = (direction: 'up' | 'down') => readFileSync(
  resolve(process.cwd(), `migrations/020_storage_project_user_access.${direction}.sql`),
  'utf8'
)
const releaseGuide = () => readFileSync(
  resolve(process.cwd(), 'docs/003-version-release-guide.md'),
  'utf8'
)

describe('storage project actor migration contract', () => {
  it('adds a closed bucket preset and object owner model', () => {
    const sql = migration('up')
    expect(sql).toContain('project_user_access')
    expect(sql).toContain("DEFAULT 'admin_only'")
    expect(sql).toMatch(/admin_only[\s\S]*owner_only[\s\S]*authenticated_read/)
    expect(sql).toContain('owner_project_user_id')
    expect(sql).toContain('varchar_pattern_ops')
  })

  it('preflights canonical names and backfills only trusted owner metadata', () => {
    const sql = migration('up')
    expect(sql).toContain('normalize(name, NFC)')
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*invalid storage object/i)
    expect(sql).toContain("metadata->>'created_by_type' IN ('project_user', 'trusted_backend_project_user')")
    expect(sql).toContain("metadata->>'created_by_project_user_id'")
  })

  it('removes dependent index and constraints before columns on down', () => {
    const sql = migration('down')
    expect(sql.indexOf('DROP INDEX')).toBeLessThan(sql.indexOf('DROP COLUMN owner_project_user_id'))
    expect(sql.indexOf('DROP CONSTRAINT')).toBeLessThan(sql.indexOf('DROP COLUMN project_user_access'))
  })

  it('documents executable legacy path and Local provider key audits', () => {
    const guide = releaseGuide()
    expect(guide).toContain("name <> normalize(name, NFC)")
    expect(guide).toContain("storage_provider = 'local'")
    expect(guide).toContain('nullif(btrim(storage_path)')
    expect(guide).toContain('GROUP BY lower(storage_path)')
    expect(guide).toContain('HAVING COUNT(*) > 1')
  })
})
