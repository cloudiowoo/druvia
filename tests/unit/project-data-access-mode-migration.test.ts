import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const upPath = 'migrations/018_project_data_access_mode.up.sql'
const downPath = 'migrations/018_project_data_access_mode.down.sql'

describe('project data access mode migration', () => {
  it('adds a constrained compatibility-default runtime mode', () => {
    expect(existsSync(upPath)).toBe(true)
    if (!existsSync(upPath)) return

    const sql = readFileSync(upPath, 'utf8')
    expect(sql).toContain('ADD COLUMN data_access_mode')
    expect(sql).toContain("DEFAULT 'compatibility'")
    expect(sql).toContain("CHECK (data_access_mode IN ('compatibility', 'explicit'))")
  })

  it('provides a controlled down migration', () => {
    expect(existsSync(downPath)).toBe(true)
    if (!existsSync(downPath)) return

    const sql = readFileSync(downPath, 'utf8')
    expect(sql).toContain('DROP COLUMN data_access_mode')
  })

  it('detects migration 018 during bootstrap', () => {
    const source = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    expect(source).toContain('18: `SELECT EXISTS (')
    expect(source).toContain("column_name = 'data_access_mode'")
  })
})
