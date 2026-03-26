import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { createFunction, invokeFunction } from '../../apps/api/src/modules/functions/functions.service.js'
import { verifyInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'
import { query, queryOne } from '../../apps/api/src/db/index.js'

const mockQuery = vi.mocked(query)
const mockQueryOne = vi.mocked(queryOne)

describe('Functions Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('creates functions with jwt_required invoke mode by default', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'fn_123',
      project_id: 'proj_123',
      name: 'upload-avatar',
      code: 'return {}',
      runtime: 'deno',
      status: 'active',
      invoke_auth_mode: 'jwt_required',
      description: null,
      created_at: new Date(),
      updated_at: new Date(),
    })

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

  it('passes trusted caller context and helper credentials to the worker during invocation', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: 'fn_123',
      project_id: 'proj_123',
      name: 'upload-avatar',
      code: 'return {}',
      runtime: 'deno',
      status: 'active',
      invoke_auth_mode: 'jwt_required',
      description: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    mockQuery.mockResolvedValueOnce([])
    mockQuery.mockResolvedValueOnce([])

    vi.mocked(global.fetch).mockResolvedValue({
      json: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    } as unknown as Response)

    await invokeFunction(
      'proj_123',
      'upload-avatar',
      { fileName: 'avatar.png' },
      {
        authType: 'platform_user',
        projectId: 'proj_123',
        role: 'user',
        userId: 'user_123',
        uid: 42,
        tenantId: 'tenant_123',
      }
    )

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    const body = JSON.parse(init!.body as string) as Record<string, unknown>
    expect(body.caller).toEqual({
      authType: 'platform_user',
      projectId: 'proj_123',
      role: 'user',
      userId: 'user_123',
      uid: 42,
      tenantId: 'tenant_123',
    })
    expect(body.apiBaseUrl).toBeUndefined()
    expect(body.internalToken).toBeTypeOf('string')

    const tokenPayload = verifyInternalFunctionToken(body.internalToken as string)
    expect(tokenPayload.projectId).toBe('proj_123')
    expect(tokenPayload.functionName).toBe('upload-avatar')
    expect(tokenPayload.authType).toBe('platform_user')
    expect(tokenPayload.role).toBe('user')
    expect(tokenPayload.userId).toBe('user_123')
    expect(tokenPayload.uid).toBe(42)
    expect(tokenPayload.tenantId).toBe('tenant_123')
  })
})
