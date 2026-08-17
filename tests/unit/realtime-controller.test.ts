import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import { checkProjectAccess } from '../../apps/api/src/lib/access.js'
import * as realtimeController from '../../apps/api/src/modules/realtime/realtime.controller.js'

function createReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  }
  reply.status.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

describe('Realtime Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(queryOne).mockResolvedValue({ schema_name: 'dru_test' } as never)
    vi.mocked(query).mockImplementation(async (sql) => {
      if (String(sql).includes('FROM information_schema.tables')) {
        return [{ table_name: 'events', realtime_enabled: true }] as never
      }
      return [] as never
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sources: [] }),
      text: vi.fn().mockResolvedValue(''),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads subscriptions once and derives stats from the same snapshot', async () => {
    const request = {
      params: { projectId: 'proj_123' },
      query: {},
      user: { userId: 'usr_123' },
    }
    const reply = createReply()

    await realtimeController.listSubscriptions(request as never, reply as never)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(reply.send).toHaveBeenCalledWith({
      success: true,
      data: {
        subscriptions: [expect.objectContaining({ tableName: 'events', enabled: true })],
        stats: { totalTables: 1, enabledTables: 1, disabledTables: 0 },
      },
    })
  })
})
