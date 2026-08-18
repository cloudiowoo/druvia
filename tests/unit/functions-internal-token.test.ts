import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'

import { config } from '../../apps/api/src/config/index.js'
import {
  signInternalFunctionToken,
  verifyInternalFunctionToken,
} from '../../apps/api/src/modules/functions/internal-token.js'
import type { ProjectActorContext } from '../../apps/api/src/lib/project-actor.js'

const projectActor: ProjectActorContext = {
  version: 1,
  actorType: 'project_user',
  source: 'project_session',
  projectId: 'proj_123',
  subject: 'project_user:pu_123',
  role: 'authenticated',
  projectUserId: 'pu_123',
  provider: 'wechat',
}

const platformActor: ProjectActorContext = {
  version: 1,
  actorType: 'platform_user',
  source: 'platform_session',
  projectId: 'proj_123',
  subject: 'platform_user:user_123',
  role: 'user',
  platformUserId: 'user_123',
  platformUid: 42,
  tenantId: 'tenant_123',
}

function signRaw(payload: Record<string, unknown>): string {
  return jwt.sign(payload, config.functions.internalTokenSecret, { expiresIn: 120 })
}

describe('Functions Internal Token', () => {
  it('signs and verifies a versioned internal actor envelope', () => {
    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      actor: projectActor,
      expiresIn: 120,
    })

    const payload = verifyInternalFunctionToken(token)

    expect(payload).toMatchObject({
      tokenType: 'function_internal',
      actorContractVersion: 1,
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      actor: projectActor,
    })
    expect(payload.exp).toBeTypeOf('number')
  })

  it.each([
    ['unknown token type', { tokenType: 'other' }],
    ['unknown outer contract version', { actorContractVersion: 2 }],
    ['outer and actor contract mismatch', { actorContractVersion: 2, actor: projectActor }],
    ['actor project mismatch', { actor: { ...projectActor, projectId: 'proj_other' } }],
    ['actor subject mismatch', { actor: { ...projectActor, subject: 'project_user:other' } }],
    ['actor source mismatch', { actor: { ...projectActor, source: 'project_api_key' } }],
    ['actor role mismatch', { actor: { ...projectActor, role: 'anon' } }],
    ['missing project user provider', { actor: { ...projectActor, provider: undefined } }],
    ['invalid API key id', {
      actor: {
        version: 1,
        actorType: 'apikey',
        source: 'project_api_key',
        projectId: 'proj_123',
        subject: 'apikey:0',
        role: 'anon',
        apiKeyId: 0,
        apiKeyPrefix: 'drv_test',
      },
    }],
    ['invalid API key prefix', {
      actor: {
        version: 1,
        actorType: 'apikey',
        source: 'project_api_key',
        projectId: 'proj_123',
        subject: 'apikey:17',
        role: 'anon',
        apiKeyId: 17,
        apiKeyPrefix: '',
      },
    }],
    ['cross-variant identity fields', {
      actor: { ...projectActor, apiKeyId: 17, apiKeyPrefix: 'drv_test' },
    }],
  ])('rejects %s', (_label, overrides) => {
    const token = signRaw({
      tokenType: 'function_internal',
      actorContractVersion: 1,
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      actor: projectActor,
      ...overrides,
    })

    expect(() => verifyInternalFunctionToken(token)).toThrow(/invalid internal function token/i)
  })

  it('rejects expired tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-23T12:00:00.000Z'))

    const token = signInternalFunctionToken({
      projectId: 'proj_123',
      functionName: 'wx-login-register',
      actor: platformActor,
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
