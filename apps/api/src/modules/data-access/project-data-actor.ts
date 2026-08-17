import type { ProjectDataAccessMode } from '@druvia/shared'
import type { ApiKeyIdentity, ProjectJwtUser, RequestUser } from '../../middleware/auth.js'
import { resolveDataScopeRole } from './data-scope-role.js'

export interface ProjectDataExecutionContext {
  kind: 'project_actor'
  role: string
  sessionVariables: Record<string, string>
}

interface ResolveProjectDataExecutionContextInput {
  projectId: string
  runtimeMode: ProjectDataAccessMode | string | null | undefined
  actor: ProjectJwtUser | ApiKeyIdentity
}

export class ProjectDataActorScopeError extends Error {
  constructor() {
    super('Project actor does not match the requested project')
    this.name = 'ProjectDataActorScopeError'
  }
}

export function isProjectDataActor(
  actor: RequestUser | undefined
): actor is ProjectJwtUser | ApiKeyIdentity {
  return actor?.kind === 'project_user' || actor?.kind === 'apikey'
}

export function resolveProjectDataExecutionContext(
  input: ResolveProjectDataExecutionContextInput
): ProjectDataExecutionContext {
  if (!isProjectDataActor(input.actor)) {
    throw new Error('Unsupported project data actor')
  }

  if (input.actor.projectId !== input.projectId) {
    throw new ProjectDataActorScopeError()
  }

  if (input.runtimeMode !== 'explicit') {
    return {
      kind: 'project_actor',
      role: 'user',
      sessionVariables: {},
    }
  }

  if (input.actor.kind === 'project_user') {
    return {
      kind: 'project_actor',
      role: resolveDataScopeRole({
        projectId: input.projectId,
        actor: 'authenticated',
      }),
      sessionVariables: {
        'x-hasura-user-id': input.actor.sub,
        'x-hasura-project-id': input.projectId,
        'x-hasura-actor-type': 'project_user',
      },
    }
  }

  if (input.actor.kind === 'apikey') {
    return {
      kind: 'project_actor',
      role: resolveDataScopeRole({
        projectId: input.projectId,
        actor: 'anonymous',
      }),
      sessionVariables: {
        'x-hasura-project-id': input.projectId,
        'x-hasura-actor-type': 'apikey',
      },
    }
  }

  throw new Error('Unsupported project data actor')
}
