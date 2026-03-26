import { describe, expect, it, vi } from 'vitest'

import {
  signInternalFunctionToken,
  verifyInternalFunctionToken,
} from '../../apps/api/src/modules/functions/internal-token.js'

describe('Functions Internal Token', () => {
  it('signs and verifies an internal function token', () => {
    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      authType: 'project_user',
      role: 'authenticated',
      projectUserId: 'pu_123',
      provider: 'wechat',
      expiresIn: 120,
    })

    const payload = verifyInternalFunctionToken(token)

    expect(payload.projectId).toBe('proj_123')
    expect(payload.functionName).toBe('wx-login-register')
    expect(payload.authType).toBe('project_user')
    expect(payload.role).toBe('authenticated')
    expect(payload.projectUserId).toBe('pu_123')
    expect(payload.provider).toBe('wechat')
    expect(payload.exp).toBeTypeOf('number')
  })

  it('rejects expired tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-23T12:00:00.000Z'))

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      authType: 'platform_user',
      expiresIn: 1,
    })

    vi.setSystemTime(new Date('2026-03-23T12:00:03.000Z'))

    expect(() => verifyInternalFunctionToken(token)).toThrow(/expired/i)

    vi.useRealTimers()
  })

  it('rejects malformed tokens', () => {
    expect(() => verifyInternalFunctionToken('not-a-valid-token')).toThrow()
  })
})
