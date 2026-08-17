import { describe, expect, it } from 'vitest'
import {
  buildTableDataAccessLink,
  filterProjectDataAccessTables,
  getAnonymousAccessLabel,
  getAuthenticatedAccessLabel,
  getDataInterfaceLabel,
  getLegacyAccessLabel,
  getRealtimeAccessLabel,
  type ProjectTableDataAccessOverview,
} from '../../../apps/admin/src/lib/project-data-access-overview.js'

function row(
  overrides: Partial<ProjectTableDataAccessOverview> = {}
): ProjectTableDataAccessOverview {
  return {
    tableName: 'orders',
    dataInterface: 'connected',
    authenticatedAccess: 'closed',
    anonymousAccess: 'closed',
    realtime: 'disabled',
    legacyAccess: { authenticated: false, anonymous: false },
    reviewRequired: false,
    ...overrides,
  }
}

describe('project data access overview presentation', () => {
  it('provides business-facing labels for every status', () => {
    expect(getDataInterfaceLabel('connected')).toBe('已连接')
    expect(getDataInterfaceLabel('not_connected')).toBe('未连接')
    expect(['closed', 'read_only', 'write_only', 'read_write', 'custom'].map(
      getAuthenticatedAccessLabel
    )).toEqual(['关闭', '只读', '只写', '读写', '需检查'])
    expect(['closed', 'read', 'custom'].map(getAnonymousAccessLabel))
      .toEqual(['关闭', '允许读取', '需检查'])
    expect(['disabled', 'access_required', 'configured'].map(getRealtimeAccessLabel))
      .toEqual(['未启用', '待授权', '已配置'])
    expect(getLegacyAccessLabel({ authenticated: false, anonymous: false })).toBe('无')
    expect(getLegacyAccessLabel({ authenticated: true, anonymous: false })).toBe('认证用户')
    expect(getLegacyAccessLabel({ authenticated: false, anonymous: true })).toBe('匿名访问')
    expect(getLegacyAccessLabel({ authenticated: true, anonymous: true }))
      .toBe('认证用户、匿名访问')
  })

  it('applies remediation filters without mixing review risks into unconfigured', () => {
    const rows = [
      row({ tableName: 'unconfigured' }),
      row({ tableName: 'anonymous', anonymousAccess: 'read' }),
      row({ tableName: 'realtime', realtime: 'access_required' }),
      row({ tableName: 'untracked', dataInterface: 'not_connected', reviewRequired: true }),
      row({ tableName: 'legacy', legacyAccess: { authenticated: true, anonymous: false }, reviewRequired: true }),
      row({ tableName: 'custom', authenticatedAccess: 'custom', reviewRequired: true }),
    ]

    expect(filterProjectDataAccessTables(rows, 'all')).toHaveLength(6)
    expect(filterProjectDataAccessTables(rows, 'unconfigured').map((item) => item.tableName))
      .toEqual(['unconfigured', 'realtime'])
    expect(filterProjectDataAccessTables(rows, 'anonymous').map((item) => item.tableName))
      .toEqual(['anonymous'])
    expect(filterProjectDataAccessTables(rows, 'realtime').map((item) => item.tableName))
      .toEqual(['realtime'])
    expect(filterProjectDataAccessTables(rows, 'review').map((item) => item.tableName))
      .toEqual(['untracked', 'legacy', 'custom'])
  })

  it('encodes route segments and requests the default data scope', () => {
    expect(buildTableDataAccessLink('tenant/a', 'project b', '订单/明细'))
      .toBe('/t/tenant%2Fa/p/project%20b/tables/%E8%AE%A2%E5%8D%95%2F%E6%98%8E%E7%BB%86?tab=access&scope=default')
  })
})
