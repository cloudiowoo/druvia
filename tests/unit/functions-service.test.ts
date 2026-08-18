import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import {
  createFunction,
  invokeFunction,
} from '../../apps/api/src/modules/functions/functions.service.js'
import { verifyInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'
import { query, queryOne } from '../../apps/api/src/db/index.js'
import type { ProjectActorContext } from '../../apps/api/src/lib/project-actor.js'
import { config } from '../../apps/api/src/config/index.js'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)

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

function functionRow(invokeAuthMode: 'jwt_required' | 'anon_allowed' = 'jwt_required') {
  return {
    id: 'fn_123',
    project_id: 'proj_123',
    name: 'upload-avatar',
    code: 'return {}',
    runtime: 'deno',
    status: 'active',
    invoke_auth_mode: invokeAuthMode,
    description: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function successfulWorkerResponse() {
  vi.mocked(global.fetch).mockResolvedValue({
    json: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
  } as unknown as Response)
}

describe('Functions Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('creates functions with jwt_required invoke mode by default', async () => {
    mockQueryOne.mockResolvedValue(functionRow())

    const func = await createFunction('proj_123', {
      name: 'upload-avatar',
      code: 'return {}',
    })

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('invoke_auth_mode'),
      ['proj_123', 'upload-avatar', 'return {}', 'jwt_required', null]
    )
    expect(func.invokeAuthMode).toBe('jwt_required')
  })

  it('sends canonical and legacy actor fields without persisting invocation payload', async () => {
    mockQueryOne.mockResolvedValueOnce(functionRow())
    mockQuery.mockResolvedValueOnce([])
    mockQuery.mockResolvedValueOnce([])
    successfulWorkerResponse()

    await invokeFunction(
      'proj_123',
      'upload-avatar',
      { fileName: 'avatar.png', secret: 'must-not-be-logged' },
      platformActor
    )

    expect(mockQueryOne).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    expect(init!.headers).toEqual({
      'Content-Type': 'application/json',
      'x-druvia-worker-secret': config.functions.workerSecret,
    })
    const body = JSON.parse(init!.body as string) as Record<string, unknown>
    expect(body.caller).toEqual({
      actorContractVersion: 1,
      actorType: 'platform_user',
      actorSource: 'platform_session',
      actorSubject: 'platform_user:user_123',
      authType: 'platform_user',
      projectId: 'proj_123',
      role: 'user',
      platformUserId: 'user_123',
      platformUid: 42,
      userId: 'user_123',
      uid: 42,
      tenantId: 'tenant_123',
    })
    expect(body.apiBaseUrl).toBeUndefined()

    const tokenPayload = verifyInternalFunctionToken(body.internalToken as string)
    expect(tokenPayload).toMatchObject({
      tokenType: 'function_internal',
      actorContractVersion: 1,
      projectId: 'proj_123',
      functionName: 'upload-avatar',
      actor: platformActor,
    })

    const logValues = mockQuery.mock.calls[1][1] as unknown[]
    const metadata = JSON.parse(logValues[5] as string)
    expect(metadata).toEqual({
      actor: {
        actorType: 'platform_user',
        actorSource: 'platform_session',
        actorSubject: 'platform_user:user_123',
        projectId: 'proj_123',
        platformUserId: 'user_123',
      },
    })
    expect(JSON.stringify(metadata)).not.toContain('avatar.png')
    expect(JSON.stringify(metadata)).not.toContain('must-not-be-logged')
  })

  it('rejects API keys for jwt_required functions before loading secrets or calling the worker', async () => {
    mockQueryOne.mockResolvedValueOnce(functionRow('jwt_required'))

    await expect(invokeFunction(
      'proj_123',
      'upload-avatar',
      { fileName: 'avatar.png' },
      apiKeyActor
    )).rejects.toMatchObject({ name: 'FunctionInvokeForbiddenError' })

    expect(mockQueryOne).toHaveBeenCalledTimes(1)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('allows API keys for anon_allowed functions and transports stable key identity', async () => {
    mockQueryOne.mockResolvedValueOnce(functionRow('anon_allowed'))
    mockQuery.mockResolvedValueOnce([])
    mockQuery.mockResolvedValueOnce([])
    successfulWorkerResponse()

    await invokeFunction('proj_123', 'upload-avatar', undefined, apiKeyActor)

    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    const body = JSON.parse(init!.body as string) as Record<string, unknown>
    expect(body.caller).toEqual({
      actorContractVersion: 1,
      actorType: 'apikey',
      actorSource: 'project_api_key',
      actorSubject: 'apikey:17',
      authType: 'apikey',
      projectId: 'proj_123',
      role: 'anon',
      apiKeyId: 17,
      apiKeyPrefix: 'drv_test',
    })
  })

  it('rejects cross-project actors before reading the function', async () => {
    await expect(invokeFunction(
      'proj_other',
      'upload-avatar',
      undefined,
      apiKeyActor
    )).rejects.toMatchObject({ name: 'FunctionActorScopeError' })

    expect(mockQueryOne).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
