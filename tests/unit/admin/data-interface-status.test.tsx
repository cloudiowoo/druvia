import { describe, expect, it } from 'vitest'
import {
  getDataInterfaceLabel,
  getDataInterfaceSyncFeedback,
  getRealtimeLabel,
  getRealtimeToggleMessage,
} from '../../../apps/admin/src/lib/data-interface-status.js'

describe('data interface status labels', () => {
  it('describes table access without exposing infrastructure terminology', () => {
    expect(getDataInterfaceLabel({ tracked: false })).toBe('未接入')
    expect(getDataInterfaceLabel({
      tracked: true,
      hasAuthenticatedRead: false,
      hasAnonymousRead: false,
    })).toBe('待配置访问')
    expect(getDataInterfaceLabel({
      tracked: true,
      hasAuthenticatedRead: true,
      hasAnonymousRead: false,
    })).toBe('可用')
    expect(getDataInterfaceLabel({
      tracked: true,
      hasAuthenticatedRead: false,
      hasAnonymousRead: true,
    })).toBe('匿名可用')
  })

  it('describes realtime readiness independently from its switch', () => {
    expect(getRealtimeLabel('disabled')).toBe('未启用')
    expect(getRealtimeLabel('access_required')).toBe('待读取权限')
    expect(getRealtimeLabel('ready')).toBe('可用')
    expect(getRealtimeLabel('unknown')).toBe('状态未知')
  })

  it('explains the next action after enabling realtime', () => {
    expect(getRealtimeToggleMessage(true, 'ready')).toBe('实时更新已启用')
    expect(getRealtimeToggleMessage(true, 'access_required')).toBe('已启用，请先配置读取权限')
    expect(getRealtimeToggleMessage(false, 'disabled')).toBe('实时更新已关闭')
  })

  it('surfaces partial failures from data interface synchronization', () => {
    expect(getDataInterfaceSyncFeedback({
      tracked: ['orders'],
      failed: ['events', 'profiles'],
      relationships: 1,
      untracked: 0,
    })).toEqual({
      title: '2 张表同步失败',
      description: 'events、profiles',
      variant: 'destructive',
    })

    expect(getDataInterfaceSyncFeedback({
      tracked: ['orders', 'events'],
      failed: [],
      relationships: 1,
      untracked: 0,
    })).toEqual({
      title: '已同步 2 张表，1 个关系',
    })
  })
})
