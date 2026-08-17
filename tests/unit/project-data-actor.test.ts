import { describe, expect, it } from 'vitest'
import {
  ProjectDataActorScopeError,
  resolveProjectDataExecutionContext,
} from '../../apps/api/src/modules/data-access/project-data-actor.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

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
}

describe('project data actor resolver', () => {
  it.each([projectUser, apiKey])(
    'maps compatibility $kind requests to the legacy user role',
    (actor) => {
      expect(resolveProjectDataExecutionContext({
        projectId: 'proj_123',
        runtimeMode: 'compatibility',
        actor,
      })).toEqual({
        kind: 'project_actor',
        role: 'user',
        sessionVariables: {},
      })
    }
  )

  it('maps an explicit project user to the scoped authenticated role', () => {
    expect(resolveProjectDataExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: projectUser,
    })).toEqual({
      kind: 'project_actor',
      role: resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }),
      sessionVariables: {
        'x-hasura-user-id': 'pusr_123',
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'project_user',
      },
    })
  })

  it('maps an explicit api key to the scoped anonymous role without user identity', () => {
    const context = resolveProjectDataExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: apiKey,
    })

    expect(context).toEqual({
      kind: 'project_actor',
      role: resolveDataScopeRole({ projectId: 'proj_123', actor: 'anonymous' }),
      sessionVariables: {
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'apikey',
      },
    })
    expect(context.sessionVariables).not.toHaveProperty('x-hasura-user-id')
  })

  it('fails unknown runtime modes closed to compatibility', () => {
    expect(resolveProjectDataExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'future-mode',
      actor: projectUser,
    })).toEqual({
      kind: 'project_actor',
      role: 'user',
      sessionVariables: {},
    })
  })

  it('rejects actors from another project', () => {
    expect(() => resolveProjectDataExecutionContext({
      projectId: 'proj_other',
      runtimeMode: 'explicit',
      actor: projectUser,
    })).toThrow(ProjectDataActorScopeError)
  })

  it('rejects unsupported future actor kinds instead of treating them as anonymous', () => {
    expect(() => resolveProjectDataExecutionContext({
      projectId: 'proj_123',
      runtimeMode: 'explicit',
      actor: {
        kind: 'service',
        projectId: 'proj_123',
        role: 'service',
      } as never,
    })).toThrow('Unsupported project data actor')
  })
})
