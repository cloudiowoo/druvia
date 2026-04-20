import { describe, expect, it } from 'vitest'
import {
  getHealthTone,
  getHealthLabel,
  getCapabilityLabel,
} from '../../../apps/admin/src/components/dashboard/health-score'

describe('health-score helpers', () => {
  it('maps score to status label and tone', () => {
    expect(getHealthLabel(92)).toBe('健康')
    expect(getHealthTone(92)).toBe('emerald')
    expect(getHealthLabel(72)).toBe('关注')
    expect(getHealthTone(72)).toBe('amber')
    expect(getHealthLabel(48)).toBe('风险')
    expect(getHealthTone(48)).toBe('red')
  })

  it('maps capability status to readable label', () => {
    expect(getCapabilityLabel('ready')).toBe('可用')
    expect(getCapabilityLabel('configured')).toBe('已配置')
    expect(getCapabilityLabel('missing')).toBe('未覆盖')
    expect(getCapabilityLabel('attention')).toBe('需关注')
  })
})
