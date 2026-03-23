import { describe, expect, it } from 'vitest'

import {
  getInvokeAuthModeBadgeMeta,
  getInvokeAuthModeLabel,
  getInvokeAuthModeWarning,
  INVOKE_AUTH_MODE_OPTIONS,
} from '../../../apps/admin/src/components/functions/invoke-auth-mode.js'

describe('Function Invoke Auth Mode', () => {
  it('exposes JWT Required and Anonymous Allowed options', () => {
    expect(INVOKE_AUTH_MODE_OPTIONS).toEqual([
      { value: 'jwt_required', label: 'JWT Required' },
      { value: 'anon_allowed', label: 'Anonymous Allowed' },
    ])
  })

  it('returns human-readable labels for both modes', () => {
    expect(getInvokeAuthModeLabel('jwt_required')).toBe('JWT Required')
    expect(getInvokeAuthModeLabel('anon_allowed')).toBe('Anonymous Allowed')
  })

  it('returns a gray JWT badge and amber ANON badge', () => {
    expect(getInvokeAuthModeBadgeMeta('jwt_required')).toEqual({
      label: 'JWT',
      className: 'bg-gray-100 text-gray-600 border-gray-200',
    })

    expect(getInvokeAuthModeBadgeMeta('anon_allowed')).toEqual({
      label: 'ANON',
      className: 'bg-amber-50 text-amber-700 border-amber-200',
    })
  })

  it('shows a warning only for anon_allowed', () => {
    expect(getInvokeAuthModeWarning('jwt_required')).toBeNull()
    expect(getInvokeAuthModeWarning('anon_allowed')).toContain('wx-silent-login')
    expect(getInvokeAuthModeWarning('anon_allowed')).toContain('JWT Required')
  })
})
