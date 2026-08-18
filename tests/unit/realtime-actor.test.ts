import { describe, expect, it } from 'vitest'
import type { RequestUser } from '../../apps/api/src/middleware/auth.js'
import {
  RealtimeActorScopeError,
  isRealtimeActor,
  resolveRealtimeExecutionContext,
} from '../../apps/api/src/modules/realtime/realtime-actor.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

const projectUser = {
  kind: 'project_user' as const,
  sub: 'usr_project_1',
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

describe('realtime actor resolver', () => {
  it('accepts only project users and API keys as Realtime actors', () => {
    expect(isRealtimeActor(projectUser)).toBe(true)
    expect(isRealtimeActor(apiKey)).toBe(true)
    expect(isRealtimeActor({ kind: 'platform_user' } as RequestUser)).toBe(false)
    expect(isRealtimeActor(undefined)).toBe(false)
  })

  it('maps a compatibility project user to the legacy user role with trusted identity', () => {
    expect(resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'compatibility',
      actor: projectUser,
    })).toEqual({
      role: 'user',
      actorType: 'project_user',
      subject: 'usr_project_1',
      sessionVariables: {
        'x-hasura-user-id': 'usr_project_1',
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'project_user',
      },
    })
  })

  it('maps a compatibility API key to the legacy anonymous role without user identity', () => {
    const context = resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'compatibility',
      actor: apiKey,
    })

    expect(context).toEqual({
      role: 'anonymous',
      actorType: 'apikey',
      subject: 'apikey:42',
      sessionVariables: {
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'apikey',
      },
    })
    expect(context.sessionVariables).not.toHaveProperty('x-hasura-user-id')
  })

  it('maps an explicit project user through the scoped role with trusted identity', () => {
    expect(resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: projectUser,
    })).toEqual({
      role: resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }),
      actorType: 'project_user',
      subject: 'usr_project_1',
      sessionVariables: {
        'x-hasura-user-id': 'usr_project_1',
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'project_user',
      },
    })
  })

  it('maps an explicit API key through the scoped role without user identity', () => {
    expect(resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: apiKey,
    })).toEqual({
      role: resolveDataScopeRole({ projectId: 'proj_123', actor: 'anonymous' }),
      actorType: 'apikey',
      subject: 'apikey:42',
      sessionVariables: {
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'apikey',
      },
    })
  })

  it('treats unknown runtime modes as compatibility', () => {
    expect(resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'future-mode',
      actor: apiKey,
    }).role).toBe('anonymous')
  })

  it('rejects an actor from another project before resolving a role', () => {
    expect(() => resolveRealtimeExecutionContext({
      projectId: 'proj_other',
      runtimeMode: 'explicit',
      actor: projectUser,
    })).toThrow(RealtimeActorScopeError)
  })

  it('rejects unsupported future actor kinds', () => {
    expect(() => resolveRealtimeExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: {
        kind: 'service',
        projectId: 'proj_123',
        role: 'service',
      } as never,
    })).toThrow('Unsupported Realtime actor')
  })
})
