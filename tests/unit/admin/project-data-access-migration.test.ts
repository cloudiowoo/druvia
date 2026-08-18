import { describe, expect, it } from 'vitest'
import {
  getMigrationPhaseProgress,
  getMigrationStatusLabel,
  requiresAliasConfirmation,
  summarizeMigrationTableAccess,
} from '../../../apps/admin/src/lib/project-data-access-migration.js'

describe('project data access migration presentation', () => {
  it('maps persisted phases to monotonic business progress', () => {
    expect(getMigrationPhaseProgress('snapshot_check')).toMatchObject({ index: 0, label: '校验快照' })
    expect(getMigrationPhaseProgress('verify_scoped_realtime').index).toBe(2)
    expect(getMigrationPhaseProgress('completed').index).toBe(5)
  })

  it('labels terminal, active, and recovery states without implementation terms', () => {
    expect(getMigrationStatusLabel('preview_ready')).toBe('预检已生成')
    expect(getMigrationStatusLabel('applying')).toBe('正在升级')
    expect(getMigrationStatusLabel('rolled_back')).toBe('已恢复兼容模式')
  })

  it('requires alias confirmation for inferred or destructive plans', () => {
    expect(requiresAliasConfirmation({ inferredOperationCount: 1, destructiveChangeCount: 0 })).toBe(true)
    expect(requiresAliasConfirmation({ inferredOperationCount: 0, destructiveChangeCount: 1 })).toBe(true)
    expect(requiresAliasConfirmation({ inferredOperationCount: 0, destructiveChangeCount: 0 })).toBe(false)
  })

  it('summarizes actor access in business language', () => {
    expect(summarizeMigrationTableAccess('read_write', true)).toBe('认证用户可读写，匿名可读')
    expect(summarizeMigrationTableAccess('closed', false)).toBe('升级后保持关闭')
  })
})
