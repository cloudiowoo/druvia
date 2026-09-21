import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project-auth/project-session-state.js', () => ({
  ProjectRuntimeBlockedError: class ProjectRuntimeBlockedError extends Error {},
  assertProjectRuntimeAvailable: vi.fn().mockResolvedValue(undefined),
  assertProjectSessionUsable: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

const { getProjectRuntimeContextMock } = vi.hoisted(() => ({
  getProjectRuntimeContextMock: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project-runtime-context.service.js', () => ({
  getProjectRuntimeContext: getProjectRuntimeContextMock,
  getRuntimeContextHasuraSessionVariables: (runtimeContext: {
    enabled: boolean;
    serviceEnvironment?: string;
  }) => runtimeContext.enabled
    ? { 'x-hasura-druvia-service-environment': runtimeContext.serviceEnvironment }
    : {},
}))

import { pool } from '../../apps/api/src/db/index.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import { internalFunctionsGraphqlRoutes } from '../../apps/api/src/modules/functions/internal-graphql.routes.js'
import { signInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'
import type { ProjectActorContext } from '../../apps/api/src/lib/project-actor.js'

const projectUserActor: ProjectActorContext = {
  version: 1,
  actorType: 'project_user',
  source: 'project_session',
  projectId: 'proj_123',
  subject: 'project_user:pu_123',
  role: 'authenticated',
  projectUserId: 'pu_123',
  provider: 'wechat',
}

const apiKeyActor: ProjectActorContext = {
  version: 1,
  actorType: 'apikey',
  source: 'project_api_key',
  projectId: 'proj_123',
  subject: 'apikey:17',
  role: 'anon',
  apiKeyId: 17,
  apiKeyPrefix: 'drv_test',
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
}

function tokenFor(actor: ProjectActorContext): string {
  return signInternalFunctionToken({
    projectId: actor.projectId,
    functionName: 'wx-login-register',
    actor,
    expiresIn: 120,
  })
}

function mockProject(runtimeMode: 'compatibility' | 'explicit' = 'explicit') {
  vi.mocked(pool.query).mockResolvedValueOnce({
    rows: [{ schema_name: 'dru_proj_123', data_access_mode: runtimeMode }],
  } as never)
  vi.mocked(pool.query).mockResolvedValueOnce({
    rows: [{ schema_name: 'dru_proj_other' }],
  } as never)
  vi.mocked(pool.query).mockResolvedValueOnce({
    rows: [{ schema_name: 'dru_proj_other_dev' }],
  } as never)
}

function mockHasuraSuccess() {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue({ data: { ok: true }, errors: null }),
  } as never)
}

describe('Functions Internal GraphQL Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pool.query).mockReset()
    getProjectRuntimeContextMock.mockReset()
    vi.stubGlobal('fetch', vi.fn())
    getProjectRuntimeContextMock.mockResolvedValue({ enabled: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('executes Project User GraphQL with server-derived scoped role and session variables', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    mockProject('explicit')
    mockHasuraSuccess()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: {
          'x-druvia-internal-token': tokenFor(projectUserActor),
          'x-hasura-role': 'admin',
          'x-hasura-user-id': 'forged-user',
        },
        payload: {
          projectId: 'proj_other',
          query: 'query { __typename }',
          variables: { id: 1 },
        },
      })

      expect(response.statusCode).toBe(200)
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT schema_name, data_access_mode FROM druvia_projects WHERE project_id = $1',
        ['proj_123']
      )
      const [, init] = vi.mocked(global.fetch).mock.calls[0]
      expect(init!.headers).toMatchObject({
        'x-hasura-role': resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }),
        'x-hasura-user-id': 'pu_123',
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'project_user',
        'x-hasura-default-schema': 'dru_proj_123',
      })
      expect(JSON.parse(init!.body as string)).toEqual({
        query: 'query { __typename }',
        variables: { id: 1 },
        operationName: undefined,
      })
    } finally {
      await app.close()
    }
  })

  it('adds the persisted runtime environment to internal GraphQL requests', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    mockProject('explicit')
    mockHasuraSuccess()
    getProjectRuntimeContextMock.mockResolvedValueOnce({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 1,
      updatedAt: '2026-09-21T00:00:00.000Z',
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': tokenFor(projectUserActor) },
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(200)
      expect(getProjectRuntimeContextMock).toHaveBeenCalledWith('proj_123')
      const [, init] = vi.mocked(global.fetch).mock.calls[0]
      expect(init!.headers).toMatchObject({
        'x-hasura-druvia-service-environment': 'sandbox',
      })
    } finally {
      await app.close()
    }
  })

  it('fails closed when runtime context resolution fails', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    mockProject('explicit')
    getProjectRuntimeContextMock.mockRejectedValueOnce(new Error('database unavailable'))

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': tokenFor(projectUserActor) },
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({
        success: false,
        error: {
          code: 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE',
          message: 'Project runtime context is unavailable',
        },
      })
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('executes API Key GraphQL with the scoped anonymous role and no user identity', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    mockProject('explicit')
    mockHasuraSuccess()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': tokenFor(apiKeyActor) },
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(200)
      const [, init] = vi.mocked(global.fetch).mock.calls[0]
      expect(init!.headers).toMatchObject({
        'x-hasura-role': resolveDataScopeRole({ projectId: 'proj_123', actor: 'anonymous' }),
        'x-hasura-project-id': 'proj_123',
        'x-hasura-actor-type': 'apikey',
      })
      expect(init!.headers).not.toHaveProperty('x-hasura-user-id')
    } finally {
      await app.close()
    }
  })

  it('rejects Platform User actors before project lookup or Hasura access', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': tokenFor(platformActor) },
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({
        success: false,
        error: {
          code: 'PROJECT_ACTOR_REQUIRED',
          message: 'Function GraphQL requires a project application actor',
        },
      })
      expect(pool.query).not.toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects invalid internal tokens with a fixed public error', async () => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': 'invalid-token' },
        payload: { query: 'query { __typename }' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' },
      })
      expect(global.fetch).not.toHaveBeenCalled()
      expect(pool.query).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it.each([
    ['project', 'query { dru_proj_other_users(limit: 1) { id } }'],
    ['environment', 'query { dru_proj_other_dev_users(limit: 1) { id } }'],
  ])('rejects GraphQL operations that reference another %s schema', async (_kind, query) => {
    const app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    mockProject('explicit')

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/functions/graphql',
        headers: { 'x-druvia-internal-token': tokenFor(apiKeyActor) },
        payload: { query },
      })

      expect(response.statusCode).toBe(403)
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
