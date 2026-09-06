import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpcLogger } = vi.hoisted(() => ({
  rpcLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

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

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  assertProjectCapability: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => rpcLogger),
}))

import * as rpcController from '../../apps/api/src/modules/rpc/rpc.controller.js'
import { callFunction, RpcError } from '../../apps/api/src/modules/rpc/rpc.service.js'
import { getProjectById } from '../../apps/api/src/modules/project/project.service.js'
import { assertProjectCapability } from '../../apps/api/src/lib/project-authorization.js'

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
    expect(assertProjectCapability).not.toHaveBeenCalled()
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
    vi.mocked(assertProjectCapability).mockResolvedValue({
      projectId: 'proj_123',
      role: 'database_admin',
      capabilities: ['database:write'],
      isWorkspaceOwner: false,
      isSuperAdmin: false,
    })
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

    expect(assertProjectCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_123' }),
      'proj_123',
      'database:write',
    )
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

  it('returns a generic HTTP 400 response for an RPC business rejection', async () => {
    vi.mocked(callFunction).mockRejectedValue(
      new RpcError('RPC_REJECTED', 'RPC request rejected'),
    )
    const reply = createReply()

    await rpcController.invokeRpc({
      params: { projectId: 'proj_123', functionName: 'complete_base_samples' },
      body: {},
      user: {
        kind: 'project_user',
        sub: 'pusr_123',
        projectId: 'proj_123',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'trusted_backend',
      },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.payload).toEqual({
      data: null,
      error: { code: 'RPC_REJECTED', message: 'RPC request rejected' },
    })
    expect(rpcLogger.warn).toHaveBeenCalledWith(
      'rpc invocation rejected',
      expect.objectContaining({ functionName: 'complete_base_samples' }),
    )
    expect(rpcLogger.error).not.toHaveBeenCalled()
  })

  it('keeps unknown RPC failures as generic HTTP 500 responses', async () => {
    vi.mocked(callFunction).mockRejectedValue(
      Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' }),
    )
    const reply = createReply()

    await rpcController.invokeRpc({
      params: { projectId: 'proj_123', functionName: 'get_profile' },
      body: {},
      user: {
        kind: 'project_user',
        sub: 'pusr_123',
        projectId: 'proj_123',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'trusted_backend',
      },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.payload).toEqual({
      data: null,
      error: { code: 'RPC_ERROR', message: 'RPC execution failed' },
    })
    expect(rpcLogger.error).toHaveBeenCalledOnce()
  })
})
