import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  'apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/members/page.tsx',
  'utf8',
)

describe('admin project members UI', () => {
  it('keeps membership writes behind members:manage', () => {
    expect(source).toContain("const canManage = can('members:manage')")
    expect(source).toContain('{canManage && (')
    expect(source).toContain('!member.isWorkspaceOwner')
  })

  it('uses confirmation dialogs for role changes and member removal', () => {
    expect(source).toContain('pendingRole')
    expect(source).toContain('pendingRemoval')
    expect(source.match(/<AlertDialog/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
