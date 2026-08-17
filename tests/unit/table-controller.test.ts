import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  trackTableInHasura: vi.fn(),
}))

import * as tableController from '../../apps/api/src/modules/table/table.controller.js'
import * as tableService from '../../apps/api/src/modules/table/table.service.js'

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
  })
})
