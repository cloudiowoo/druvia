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
        provider: 'wechat',
      },
    }

    await rpcController.invokeRpc(request as never, reply as never)

    expect(callFunction).toHaveBeenCalledWith('dru_default_taroapp', 'get_profile', { id: 1 })
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
      },
    }

    await rpcController.invokeRpc(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    })
  })
})
