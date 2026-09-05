import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const upSql = readFileSync(
  resolve(process.cwd(), 'migrations/022_project_members.up.sql'),
  'utf8',
)
const downSql = readFileSync(
  resolve(process.cwd(), 'migrations/022_project_members.down.sql'),
  'utf8',
)

describe('migration 022 project members contract', () => {
  it('creates project-scoped platform memberships with fixed roles', () => {
    expect(upSql).toContain('CREATE TABLE druvia_project_members')
    expect(upSql).toMatch(/project_id[\s\S]*REFERENCES druvia_projects\(project_id\) ON DELETE CASCADE/)
    expect(upSql).toMatch(/user_uid[\s\S]*REFERENCES druvia_users\(id\) ON DELETE CASCADE/)
    expect(upSql).toMatch(/created_by[\s\S]*REFERENCES druvia_users\(id\) ON DELETE SET NULL/)
    expect(upSql).toContain("CHECK (role IN ('project_admin', 'database_admin', 'viewer'))")
    expect(upSql).toContain('UNIQUE (project_id, user_uid)')
  })

  it('indexes user membership lookup and maintains updated_at', () => {
    expect(upSql).toContain('idx_druvia_project_members_user')
    expect(upSql).toContain('(user_uid, project_id)')
    expect(upSql).toContain('CREATE TRIGGER druvia_project_members_updated_at')
    expect(upSql).toContain('EXECUTE FUNCTION druvia_update_updated_at()')
  })

  it('refuses rollback while membership data exists', () => {
    expect(downSql).toMatch(/IF EXISTS \(SELECT 1 FROM druvia_project_members LIMIT 1\)/)
    expect(downSql).toContain("USING ERRCODE = '55006'")
    expect(downSql).toContain('DROP TRIGGER IF EXISTS druvia_project_members_updated_at')
    expect(downSql).toContain('DROP TABLE druvia_project_members')
  })
})
