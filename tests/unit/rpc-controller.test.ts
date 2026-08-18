import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/rpc/rpc.service.js', () => ({
  callFunction: vi.fn(),
  RpcError: class RpcError extends Error {
    constructor(public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

import * as rpcController from '../../apps/api/src/modules/rpc/rpc.controller.js'
import { callFunction } from '../../apps/api/src/modules/rpc/rpc.service.js'
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js'
import { checkProjectAccess } from '../../apps/api/src/lib/access.js'

type ReplyStub = {
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  statusCode?: number
  payload?: unknown
}

function createReply(): ReplyStub {
  const reply: ReplyStub = {
    status: vi.fn(),
    send: vi.fn(),
  }

  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code
    return reply
  })

  reply.send.mockImplementation((payload: unknown) => {
    reply.payload = payload
    return reply
  })

  return reply
}

describe('RPC Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_default_taroapp',
    } as Awaited<ReturnType<typeof getProjectById>>)
  })

  it('allows same-project project users to invoke RPC without tenant owner checks', async () => {
    vi.mocked(callFunction).mockResolvedValue({ ok: true })

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', functionName: 'get_profile' },
      body: { args: { id: 1 } },
      user: {
        kind: 'project_user' as const,
        sub: 'usr_proj_1',
        projectId: 'proj_123',
        authType: 'project_user' as const,
        role: 'authenticated' as const,
        provider: 'trusted_backend',
      },
    }

    await rpcController.invokeRpc(request as never, reply as never)

    expect(callFunction).toHaveBeenCalledWith(
      'dru_default_taroapp',
      'get_profile',
      { id: 1 },
      {
        version: 1,
        actorType: 'project_user',
        source: 'project_session',
        projectId: 'proj_123',
        subject: 'project_user:usr_proj_1',
        role: 'authenticated',
        projectUserId: 'usr_proj_1',
        provider: 'trusted_backend',
      }
    )
    expect(checkProjectAccess).not.toHaveBeenCalled()
    expect(reply.payload).toEqual({
      data: { ok: true },
      error: null,
    })
  })

  it('rejects anonymous apikey RPC access', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', functionName: 'get_profile' },
      body: {},
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_123',
        role: 'anon' as const,
        apiKeyId: 42,
        apiKeyPrefix: 'dru_fixture1',
      },
    }

    await rpcController.invokeRpc(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    })
  })

  it('passes an authorized Platform User as an explicit management actor', async () => {
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(callFunction).mockResolvedValue({ ok: true })
    const reply = createReply()

    await rpcController.invokeRpc({
      params: { projectId: 'proj_123', functionName: 'get_profile' },
      body: {},
      user: {
        kind: 'platform_user',
        userId: 'user_123',
        uid: 7,
        role: 'admin',
      },
    } as never, reply as never)

    expect(checkProjectAccess).toHaveBeenCalledWith('user_123', 'proj_123')
    expect(callFunction).toHaveBeenCalledWith(
      'dru_default_taroapp',
      'get_profile',
      undefined,
      expect.objectContaining({
        actorType: 'platform_user',
        subject: 'platform_user:user_123',
        platformUid: 7,
      })
    )
  })

  it('rejects a cross-project Project User before invoking the service', async () => {
    const reply = createReply()

    await rpcController.invokeRpc({
      params: { projectId: 'proj_123', functionName: 'get_profile' },
      body: {},
      user: {
        kind: 'project_user',
        sub: 'pusr_other',
        projectId: 'proj_other',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(callFunction).not.toHaveBeenCalled()
  })
})
