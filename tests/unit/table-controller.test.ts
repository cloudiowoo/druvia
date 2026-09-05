import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  getHasuraStatus: vi.fn(),
  trackTableInHasura: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  DataAccessMutationLockedError: class DataAccessMutationLockedError extends Error {
    readonly code = 'DATA_ACCESS_MIGRATION_IN_PROGRESS'
  },
  withSchemaDataAccessMutationLock: vi.fn(async (_schemaName, callback) => callback(null)),
}))

import * as tableController from '../../apps/api/src/modules/table/table.controller.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import {
  DataAccessMutationLockedError,
  withSchemaDataAccessMutationLock,
} from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

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

describe('Table Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_YlWn_0Yswm3TLPww',
      schemaName: 'dru_default_pitchetch',
      dataAccessMode: 'explicit',
    } as never)
  })

  it('returns a gateway failure when the data interface cannot track a table', async () => {
    vi.mocked(tableService.trackTableInHasura).mockResolvedValue(false)
    const reply = createReply()
    const request = {
      params: { schemaName: 'dru_test', tableName: 'orders' },
    }

    await tableController.trackTableInHasura(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(502)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'DATA_INTERFACE_SYNC_FAILED',
        message: 'Unable to connect table to data interface',
      },
    })
    expect(withSchemaDataAccessMutationLock).toHaveBeenCalledWith(
      'dru_test', expect.any(Function)
    )
  })

  it('maps a migration lock conflict before table tracking', async () => {
    vi.mocked(withSchemaDataAccessMutationLock).mockRejectedValueOnce(
      new DataAccessMutationLockedError('busy')
    )
    const reply = createReply()

    await tableController.trackTableInHasura({
      params: { schemaName: 'dru_test', tableName: 'orders' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.payload).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'DATA_ACCESS_MIGRATION_IN_PROGRESS' }),
    }))
    expect(tableService.trackTableInHasura).not.toHaveBeenCalled()
  })

  it('checks Hasura status with the authorized project scoped roles', async () => {
    vi.mocked(tableService.getHasuraStatus).mockResolvedValue({})
    const reply = createReply()

    await tableController.getHasuraStatus({
      params: { schemaName: 'dru_default_pitchetch' },
      projectAccess: { projectId: 'proj_YlWn_0Yswm3TLPww' },
    } as never, reply as never)

    expect(tableService.getHasuraStatus).toHaveBeenCalledWith(
      'dru_default_pitchetch',
      {
        authenticated: resolveDataScopeRole({
          projectId: 'proj_YlWn_0Yswm3TLPww',
          actor: 'authenticated',
        }),
        anonymous: resolveDataScopeRole({
          projectId: 'proj_YlWn_0Yswm3TLPww',
          actor: 'anonymous',
        }),
      },
      'available'
    )
    expect(reply.payload).toEqual({ success: true, data: {} })
  })

  it('checks compatibility projects with legacy application roles only', async () => {
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_legacy',
      schemaName: 'dru_default_legacy',
      dataAccessMode: 'compatibility',
    } as never)
    vi.mocked(tableService.getHasuraStatus).mockResolvedValue({})
    const reply = createReply()

    await tableController.getHasuraStatus({
      params: { schemaName: 'dru_default_legacy' },
      projectAccess: { projectId: 'proj_legacy' },
    } as never, reply as never)

    expect(tableService.getHasuraStatus).toHaveBeenCalledWith(
      'dru_default_legacy',
      { authenticated: 'user', anonymous: 'anonymous' },
      'available'
    )
  })

  it('marks non-default environment access unavailable without using production roles', async () => {
    vi.mocked(tableService.getHasuraStatus).mockResolvedValue({})
    const reply = createReply()

    await tableController.getHasuraStatus({
      params: { schemaName: 'dru_preview_pitchetch' },
      projectAccess: { projectId: 'proj_YlWn_0Yswm3TLPww' },
    } as never, reply as never)

    expect(tableService.getHasuraStatus).toHaveBeenCalledWith(
      'dru_preview_pitchetch',
      undefined,
      'environment_identity_required'
    )
  })
})
