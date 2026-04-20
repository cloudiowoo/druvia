import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/dashboard/dashboard.service.js', () => ({
  getTenantOverview: vi.fn(),
  getTenantProjectHealth: vi.fn(),
  getTenantTimeline: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkTenantAccess: vi.fn(),
}))

import * as dashboardController from '../../apps/api/src/modules/dashboard/dashboard.controller.js'
import * as dashboardService from '../../apps/api/src/modules/dashboard/dashboard.service.js'
import * as access from '../../apps/api/src/lib/access.js'

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

describe('Tenant dashboard controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects apikey users for workspace dashboard routes', async () => {
    const reply = createReply()
    const request = {
      params: { tenantId: 'default' },
      user: { kind: 'apikey' as const, projectId: 'proj_123', role: 'anon' as const },
    }

    await dashboardController.getTenantOverview(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
    expect(vi.mocked(dashboardService.getTenantOverview)).not.toHaveBeenCalled()
  })

  it('rejects project users for workspace dashboard routes', async () => {
    const reply = createReply()
    const request = {
      params: { tenantId: 'default' },
      user: {
        kind: 'project_user' as const,
        sub: 'usr_proj_123',
        projectId: 'proj_123',
        authType: 'project_user' as const,
        role: 'authenticated' as const,
        provider: 'wechat',
      },
    }

    await dashboardController.getTenantOverview(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
    expect(vi.mocked(dashboardService.getTenantOverview)).not.toHaveBeenCalled()
  })

  it('rejects platform users without tenant access', async () => {
    vi.mocked(access.checkTenantAccess).mockResolvedValue(false)

    const reply = createReply()
    const request = {
      params: { tenantId: 'default' },
      user: { kind: 'platform_user' as const, userId: 'usr_other', uid: 2, role: 'admin' as const },
    }

    await dashboardController.getTenantOverview(request as never, reply as never)

    expect(access.checkTenantAccess).toHaveBeenCalledWith('usr_other', 'default')
    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this tenant' },
    })
    expect(vi.mocked(dashboardService.getTenantOverview)).not.toHaveBeenCalled()
  })
})
