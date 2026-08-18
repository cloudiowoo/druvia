import type { ProjectDataAccessMode } from '@druvia/shared'
import type { ApiKeyIdentity, ProjectJwtUser, RequestUser } from '../../middleware/auth.js'
import { resolveDataScopeRole } from '../data-access/data-scope-role.js'

export interface RealtimeExecutionContext {
  role: string
  actorType: 'project_user' | 'apikey'
  subject: string
  sessionVariables: Record<string, string>
}

interface ResolveRealtimeExecutionContextInput {
  projectId: string
  runtimeMode: ProjectDataAccessMode | string | null | undefined
  actor: ProjectJwtUser | ApiKeyIdentity
}

export class RealtimeActorScopeError extends Error {
  constructor() {
    super('Realtime actor does not match the requested project')
    this.name = 'RealtimeActorScopeError'
  }
}

export function isRealtimeActor(
  actor: RequestUser | undefined
): actor is ProjectJwtUser | ApiKeyIdentity {
  return actor?.kind === 'project_user' || actor?.kind === 'apikey'
}

export function resolveRealtimeExecutionContext(
  input: ResolveRealtimeExecutionContextInput
): RealtimeExecutionContext {
  if (!isRealtimeActor(input.actor)) {
    throw new Error('Unsupported Realtime actor')
  }

  if (input.actor.projectId !== input.projectId) {
    throw new RealtimeActorScopeError()
  }

  if (input.actor.kind === 'project_user') {
    return {
      role: input.runtimeMode === 'explicit'
        ? resolveDataScopeRole({ projectId: input.projectId, actor: 'authenticated' })
        : 'user',
      actorType: 'project_user',
      subject: input.actor.sub,
      sessionVariables: {
        'x-hasura-user-id': input.actor.sub,
        'x-hasura-project-id': input.projectId,
        'x-hasura-actor-type': 'project_user',
      },
    }
  }

  return {
    role: input.runtimeMode === 'explicit'
      ? resolveDataScopeRole({ projectId: input.projectId, actor: 'anonymous' })
      : 'anonymous',
    actorType: 'apikey',
    subject: `apikey:${input.actor.apiKeyId}`,
    sessionVariables: {
      'x-hasura-project-id': input.projectId,
      'x-hasura-actor-type': 'apikey',
    },
  }
}
