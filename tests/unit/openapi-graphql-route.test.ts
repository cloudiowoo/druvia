import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

const {
  authState,
  authenticateMock,
  isJwtUserMock,
  checkProjectAccessMock,
  getProjectByIdMock,
  checkProjectGraphqlRateLimitMock,
  getProjectRuntimeContextMock,
} = vi.hoisted(() => ({
  authState: { user: undefined as unknown },
  authenticateMock: vi.fn(),
  isJwtUserMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
  getProjectByIdMock: vi.fn(),
  checkProjectGraphqlRateLimitMock: vi.fn(),
  getProjectRuntimeContextMock: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/modules/openapi/openapi.service.js', () => ({
  generateProjectOpenApi: vi.fn(),
}))

vi.mock('../../apps/api/src/middleware/auth.js', () => ({
  authenticate: authenticateMock,
  isJwtUser: isJwtUserMock,
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: checkProjectAccessMock,
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: getProjectByIdMock,
}))

vi.mock('../../apps/api/src/modules/project/project-runtime-context.service.js', () => ({
  getProjectRuntimeContext: getProjectRuntimeContextMock,
  getRuntimeContextHasuraSessionVariables: (runtimeContext: {
    enabled: boolean;
    serviceEnvironment?: string;
  }) => runtimeContext.enabled
    ? { 'x-hasura-druvia-service-environment': runtimeContext.serviceEnvironment }
    : {},
  ProjectRuntimeContextError: class ProjectRuntimeContextError extends Error {},
}))

vi.mock('../../apps/api/src/middleware/ratelimit.js', async () => {
  const actual = await vi.importActual<typeof import('../../apps/api/src/middleware/ratelimit.js')>(
    '../../apps/api/src/middleware/ratelimit.js'
  )

  return {
    ...actual,
    checkProjectGraphqlRateLimit: checkProjectGraphqlRateLimitMock,
  }
})

import { openapiRoutes } from '../../apps/api/src/modules/openapi/openapi.routes.js'

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
  userId: 'usr_platform',
  uid: 1,
  role: 'admin',
}

describe('OpenAPI GraphQL proxy route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    authState.user = apiKey
    authenticateMock.mockImplementation(async (request) => {
      request.user = authState.user
    })
    isJwtUserMock.mockImplementation((user) => user?.kind === 'platform_user')
    checkProjectAccessMock.mockResolvedValue(true)
    getProjectByIdMock.mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      dataAccessMode: 'compatibility',
      settings: {
        rateLimits: {
          graphql: { perUser: 120, perProject: 1000 },
        },
      },
    })
    checkProjectGraphqlRateLimitMock.mockImplementation(async () => {})
    getProjectRuntimeContextMock.mockResolvedValue({ enabled: false })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { __typename: 'query_root' } }),
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects platform jwt before project loading or Hasura execution', async () => {
    authState.user = platformUser
    const response = await injectGraphql()

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'PROJECT_ACTOR_REQUIRED',
        message: 'Project actor credential required',
      },
    })
    expect(checkProjectAccessMock).not.toHaveBeenCalled()
    expect(getProjectByIdMock).not.toHaveBeenCalled()
    expect(checkProjectGraphqlRateLimitMock).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects unsupported identity kinds before project loading or Hasura execution', async () => {
    authState.user = {
      kind: 'service',
      projectId: 'proj_123',
      role: 'service',
    }
    const response = await injectGraphql()

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'PROJECT_ACTOR_REQUIRED',
        message: 'Project actor credential required',
      },
    })
    expect(getProjectByIdMock).not.toHaveBeenCalled()
    expect(checkProjectGraphqlRateLimitMock).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it.each([projectUser, apiKey])(
    'rejects a cross-project $kind before loading the project',
    async (actor) => {
      authState.user = { ...actor, projectId: 'proj_other' }
      const response = await injectGraphql()

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({
        success: false,
        error: {
          code: 'PROJECT_SCOPE_MISMATCH',
          message: 'Project actor does not match the requested project',
        },
      })
      expect(getProjectByIdMock).not.toHaveBeenCalled()
      expect(checkProjectGraphqlRateLimitMock).not.toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    }
  )

  it.each([
    [projectUser, 'project_user', 'project_session', 'pusr_123'],
    [apiKey, 'apikey', 'project_api_key', null],
  ] as const)(
    'adds the v1 actor contract to compatibility $kind requests',
    async (actor, actorType, actorSource, projectUserId) => {
      authState.user = actor
      const response = await injectGraphql({
        'x-hasura-druvia-actor-source': 'forged-source',
        'x-hasura-druvia-project-user-id': 'forged-user',
      })

      expect(response.statusCode).toBe(200)
      const headers = proxiedHeaders()
      expect(headers.get('x-hasura-role')).toBe('user')
      expect(headers.get('x-hasura-user-id')).toBeNull()
      expect(headers.get('x-hasura-project-id')).toBeNull()
      expect(headers.get('x-hasura-actor-type')).toBeNull()
      expect(headers.get('x-hasura-druvia-actor-contract-version')).toBe('1')
      expect(headers.get('x-hasura-druvia-actor-type')).toBe(actorType)
      expect(headers.get('x-hasura-druvia-actor-source')).toBe(actorSource)
      expect(headers.get('x-hasura-druvia-project-id')).toBe('proj_123')
      expect(headers.get('x-hasura-druvia-project-user-id')).toBe(projectUserId)
    }
  )

  it('maps an explicit project user to server-derived Hasura headers', async () => {
    authState.user = projectUser
    getProjectByIdMock.mockResolvedValueOnce({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      dataAccessMode: 'explicit',
      settings: {},
    })

    const response = await injectGraphql({
      'x-hasura-role': 'admin',
      'x-hasura-user-id': 'client-controlled',
    })

    expect(response.statusCode).toBe(200)
    const headers = proxiedHeaders()
    expect(headers.get('x-hasura-role')).toBe(resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'authenticated',
    }))
    expect(headers.get('x-hasura-user-id')).toBe('pusr_123')
    expect(headers.get('x-hasura-project-id')).toBe('proj_123')
    expect(headers.get('x-hasura-actor-type')).toBe('project_user')
    expect(headers.get('x-hasura-druvia-actor-contract-version')).toBe('1')
    expect(headers.get('x-hasura-druvia-actor-type')).toBe('project_user')
    expect(headers.get('x-hasura-druvia-actor-source')).toBe('project_session')
    expect(headers.get('x-hasura-druvia-project-id')).toBe('proj_123')
    expect(headers.get('x-hasura-druvia-project-user-id')).toBe('pusr_123')
  })

  it('injects the persisted runtime environment and ignores a caller supplied value', async () => {
    authState.user = projectUser
    getProjectRuntimeContextMock.mockResolvedValueOnce({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 3,
      updatedAt: '2026-09-21T00:00:00.000Z',
    })

    const response = await injectGraphql({
      'x-hasura-druvia-service-environment': 'production',
    })

    expect(response.statusCode).toBe(200)
    expect(getProjectRuntimeContextMock).toHaveBeenCalledWith('proj_123')
    expect(proxiedHeaders().get('x-hasura-druvia-service-environment')).toBe('sandbox')
  })

  it('keeps legacy GraphQL requests free of the runtime environment header when unconfigured', async () => {
    const response = await injectGraphql({
      'x-hasura-druvia-service-environment': 'production',
    })

    expect(response.statusCode).toBe(200)
    expect(proxiedHeaders().get('x-hasura-druvia-service-environment')).toBeNull()
  })

  it('fails closed when runtime context resolution is unavailable', async () => {
    getProjectRuntimeContextMock.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await injectGraphql()

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE',
        message: 'Project runtime context is unavailable',
      },
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('maps an explicit api key to anonymous headers without user identity', async () => {
    authState.user = apiKey
    getProjectByIdMock.mockResolvedValueOnce({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
      dataAccessMode: 'explicit',
      settings: {},
    })

    const response = await injectGraphql({
      'x-hasura-role': 'admin',
      'x-hasura-user-id': 'client-controlled',
    })

    expect(response.statusCode).toBe(200)
    const headers = proxiedHeaders()
    expect(headers.get('x-hasura-role')).toBe(resolveDataScopeRole({
      projectId: 'proj_123',
      actor: 'anonymous',
    }))
    expect(headers.get('x-hasura-user-id')).toBeNull()
    expect(headers.get('x-hasura-project-id')).toBe('proj_123')
    expect(headers.get('x-hasura-actor-type')).toBe('apikey')
    expect(headers.get('x-hasura-druvia-actor-contract-version')).toBe('1')
    expect(headers.get('x-hasura-druvia-actor-type')).toBe('apikey')
    expect(headers.get('x-hasura-druvia-actor-source')).toBe('project_api_key')
    expect(headers.get('x-hasura-druvia-project-id')).toBe('proj_123')
    expect(headers.get('x-hasura-druvia-project-user-id')).toBeNull()
  })

  it('loads the project once and forwards its rate-limit settings', async () => {
    authState.user = projectUser

    const response = await injectGraphql()

    expect(response.statusCode).toBe(200)
    expect(getProjectByIdMock).toHaveBeenCalledTimes(1)
    expect(getProjectByIdMock).toHaveBeenCalledWith('proj_123')
    expect(checkProjectGraphqlRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'proj_123',
      { perUser: 120, perProject: 1000 }
    )
  })
})

async function injectGraphql(headers: Record<string, string> = {}) {
  const app = Fastify()
  await app.register(openapiRoutes, { prefix: '/api/v1' })
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj_123/graphql',
      headers,
      payload: { query: 'query { __typename }' },
    })
  } finally {
    await app.close()
  }
}

function proxiedHeaders(): Headers {
  expect(global.fetch).toHaveBeenCalledTimes(1)
  const [, init] = vi.mocked(global.fetch).mock.calls[0]
  return new Headers(init?.headers)
}
