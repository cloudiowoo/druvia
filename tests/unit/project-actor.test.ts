import { describe, expect, it } from 'vitest'
import {
  ProjectActorRequiredError,
  ProjectActorScopeError,
  resolvePlatformProjectActor,
  resolveScopedProjectActor,
  toProjectActorAuditContext,
  toProjectActorClaims,
} from '../../apps/api/src/lib/project-actor.js'

const projectUser = {
  kind: 'project_user' as const,
  sub: 'pusr_123',
  projectId: 'proj_123',
  authType: 'project_user' as const,
  role: 'authenticated' as const,
  provider: 'wechat',
}

const apiKey = {
  kind: 'apikey' as const,
  projectId: 'proj_123',
  role: 'anon' as const,
  apiKeyId: 42,
  apiKeyPrefix: 'dru_fixture1',
}

const platformUser = {
  kind: 'platform_user' as const,
  userId: 'user_123',
  uid: 7,
  tenantId: 'tenant_123',
  role: 'admin',
}

describe('project actor contract', () => {
  it('normalizes a same-project Project User with a stable subject', () => {
    expect(resolveScopedProjectActor(projectUser, 'proj_123')).toEqual({
      version: 1,
      actorType: 'project_user',
      source: 'project_session',
      projectId: 'proj_123',
      subject: 'project_user:pusr_123',
      role: 'authenticated',
      projectUserId: 'pusr_123',
      provider: 'wechat',
    })
  })

  it('normalizes an API Key without retaining a full key or hash', () => {
    const actor = resolveScopedProjectActor({
      ...apiKey,
      key: 'dru_full_secret',
      keyHash: 'hash-secret',
    }, 'proj_123')

    expect(actor).toEqual({
      version: 1,
      actorType: 'apikey',
      source: 'project_api_key',
      projectId: 'proj_123',
      subject: 'apikey:42',
      role: 'anon',
      apiKeyId: 42,
      apiKeyPrefix: 'dru_fixture1',
    })
    expect(actor).not.toHaveProperty('key')
    expect(actor).not.toHaveProperty('keyHash')
  })

  it('requires prior project authorization before normalizing Platform User', () => {
    expect(resolvePlatformProjectActor(platformUser, 'proj_123')).toEqual({
      version: 1,
      actorType: 'platform_user',
      source: 'platform_session',
      projectId: 'proj_123',
      subject: 'platform_user:user_123',
      role: 'admin',
      platformUserId: 'user_123',
      platformUid: 7,
      tenantId: 'tenant_123',
    })
  })

  it('uses the compatibility role when Platform User has no role', () => {
    expect(resolvePlatformProjectActor({ ...platformUser, role: undefined }, 'proj_123').role)
      .toBe('authenticated')
  })

  it('rejects cross-project and unsupported scoped identities', () => {
    expect(() => resolveScopedProjectActor(projectUser, 'proj_other'))
      .toThrow(ProjectActorScopeError)
    expect(() => resolveScopedProjectActor(platformUser, 'proj_123'))
      .toThrow(ProjectActorRequiredError)
  })

  it.each([
    { ...apiKey, apiKeyId: 0 },
    { ...apiKey, apiKeyId: -1 },
    { ...apiKey, apiKeyId: 1.5 },
    { ...apiKey, apiKeyPrefix: '' },
  ])('rejects malformed API Key identity %#', (identity) => {
    expect(() => resolveScopedProjectActor(identity, 'proj_123'))
      .toThrow(ProjectActorRequiredError)
  })

  it('projects safe audit and PostgreSQL claim fields', () => {
    const actor = resolveScopedProjectActor(projectUser, 'proj_123')

    expect(toProjectActorAuditContext(actor)).toEqual({
      actorType: 'project_user',
      actorSource: 'project_session',
      actorSubject: 'project_user:pusr_123',
      projectId: 'proj_123',
      projectUserId: 'pusr_123',
    })
    expect(toProjectActorClaims(actor)).toEqual({
      sub: 'project_user:pusr_123',
      role: 'authenticated',
      project_id: 'proj_123',
      actor_type: 'project_user',
      actor_source: 'project_session',
      project_user_id: 'pusr_123',
      provider: 'wechat',
    })
  })
})
