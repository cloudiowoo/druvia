import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('migration 030 projection grant extension', () => {
  it('adds a distinct operation kind and blocks down while extension history exists', () => {
    const up = 'migrations/030_data_access_grant_extension.up.sql'
    const down = 'migrations/030_data_access_grant_extension.down.sql'
    expect(existsSync(up)).toBe(true)
    expect(existsSync(down)).toBe(true)
    if (!existsSync(up) || !existsSync(down)) return
    expect(readFileSync(up, 'utf8')).toContain("'grant_extension'")
    expect(readFileSync(down, 'utf8')).toContain("kind = 'grant_extension'")
    expect(readFileSync(down, 'utf8')).toContain("ERRCODE = '55006'")
  })

  it('does not bootstrap from a same-named constraint in a project schema', () => {
    const runner = readFileSync('apps/api/src/cli/migrate.ts', 'utf8')
    expect(runner).toMatch(/conrelid\s*=\s*to_regclass\('public\.druvia_data_access_policy_operations'\)/)
    expect(runner).toMatch(/contype\s*=\s*'c'/)
    expect(runner).toContain("'%grant_extension%'")
  })
})
