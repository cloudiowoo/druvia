import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  trackTableInHasura: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  DataAccessMutationLockedError: class DataAccessMutationLockedError extends Error {
    readonly code = 'DATA_ACCESS_MIGRATION_IN_PROGRESS'
  },
  withSchemaDataAccessMutationLock: vi.fn(async (_schemaName, callback) => callback(null)),
}))

import * as tableController from '../../apps/api/src/modules/table/table.controller.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'
import {
  DataAccessMutationLockedError,
  withSchemaDataAccessMutationLock,
} from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'

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
})
