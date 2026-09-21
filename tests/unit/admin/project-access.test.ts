import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectAccess } from '@druvia/shared'
import {
  filterProjectNavigation,
  hasProjectCapability,
  requiredProjectCapability,
} from '../../../apps/admin/src/lib/project-access'
import { buildProjectNav } from '../../../apps/admin/src/components/sidebar-nav'

function access(capabilities: ProjectAccess['capabilities']): ProjectAccess {
  return {
    projectId: 'proj_1', role: 'database_admin', capabilities,
    isWorkspaceOwner: false, isSuperAdmin: false,
  }
}

describe('admin project access', () => {
  it('checks only server-provided capabilities', () => {
    const value = access(['project:read', 'database:read'])
    expect(hasProjectCapability(value, 'database:read')).toBe(true)
    expect(hasProjectCapability(value, 'database:write')).toBe(false)
    expect(hasProjectCapability(null, 'project:read')).toBe(false)
  })

  it('filters project navigation by capability', () => {
    const items = filterProjectNavigation(buildProjectNav('default', 'proj_1'), access([
      'project:read', 'members:read', 'database:read', 'database:write',
      'data_access:manage', 'realtime:manage',
    ]))
    expect(items.map((item) => item.label)).toEqual([
      '概览', '数据表', '数据库', '实时', 'API', '个人设置', '项目设置',
    ])
  })

  it('keeps viewer navigation read-only', () => {
    const items = filterProjectNavigation(buildProjectNav('default', 'proj_1'), access([
      'project:read', 'members:read', 'database:read',
    ]))
    expect(items.map((item) => item.label)).toEqual([
      '概览', '数据表', '数据库', 'API', '个人设置', '项目设置',
    ])
  })

  it('maps direct project routes to their required capability', () => {
    expect(requiredProjectCapability('/t/default/p/proj_1/auth')).toBe('auth:manage')
    expect(requiredProjectCapability('/t/default/p/proj_1/settings/api-keys')).toBe('api_keys:manage')
    expect(requiredProjectCapability('/t/default/p/proj_1/settings/runtime-context')).toBe('runtime_context:manage')
    expect(requiredProjectCapability('/t/default/p/proj_1/settings/members')).toBe('members:read')
    expect(requiredProjectCapability('/t/default/p/proj_1/tables/orders')).toBe('database:read')
    expect(requiredProjectCapability('/t/default/p/proj_1/api')).toBe('database:read')
    expect(requiredProjectCapability('/t/default/p/proj_1')).toBe('project:read')
  })

  it('reloads environments when project access becomes available', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'apps/admin/src/components/DashboardLayout.tsx'),
      'utf8',
    )

    expect(source).toContain(
      "const canManageEnvironments = hasProjectCapability(currentProjectAccess, 'environments:manage')",
    )
    expect(source).toContain(
      '[projectId, currentProject?.schemaName, canManageEnvironments]',
    )
  })

  it('invalidates cached project access after a project-scoped forbidden response', () => {
    const apiSource = readFileSync(
      resolve(process.cwd(), 'apps/admin/src/lib/api.ts'),
      'utf8',
    )
    const layoutSource = readFileSync(
      resolve(process.cwd(), 'apps/admin/src/app/t/[tenantId]/p/[projectId]/layout.tsx'),
      'utf8',
    )

    expect(apiSource).toContain("window.dispatchEvent(new CustomEvent('druvia:project-forbidden'")
    expect(layoutSource).toContain("window.addEventListener('druvia:project-forbidden'")
    expect(layoutSource).toContain('setCurrentProjectAccess(null)')
  })
})
