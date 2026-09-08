import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(),
  getWithClient: vi.fn(),
  complete: vi.fn(),
  withLock: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/table/table-deletion-outbox.repository.js', () => ({
  listPendingTableDeletions: mocks.listPending,
  getTableDeletionWithClient: mocks.getWithClient,
}))
vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({
  completePendingTableDeletion: mocks.complete,
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: mocks.withLock,
}))

import {
  recoverPendingTableDeletions,
  startTableDeletionRecoveryLoop,
} from '../../apps/api/src/modules/table/table-deletion-recovery.service.js'

const operation = {
  operationId: 'td_1', lockScope: 'proj_1', schemaName: 'dru_proj_1', tableName: 'orders',
  status: 'pending' as const, attempts: 1, lastError: 'TABLE_UNTRACK_FAILED',
  createdAt: new Date(), updatedAt: new Date(),
}

describe('table deletion startup recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listPending.mockResolvedValue([operation])
    mocks.getWithClient.mockResolvedValue(operation)
    mocks.complete.mockResolvedValue(undefined)
    mocks.withLock.mockImplementation(async (_scope, callback) => callback({ query: vi.fn() }))
  })

  it('replays each persisted deletion under the exclusive recovery lock', async () => {
    await expect(recoverPendingTableDeletions()).resolves.toEqual({ recovered: 1, failed: 0 })

    expect(mocks.withLock).toHaveBeenCalledWith(
      'proj_1',
      expect.any(Function),
      { globalMode: 'exclusive', purpose: 'table_delete_recovery', operationId: 'td_1' }
    )
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), operation)
  })

  it('keeps a failed outbox item pending without stopping later startup recovery', async () => {
    const second = { ...operation, operationId: 'td_2', tableName: 'events' }
    mocks.listPending.mockResolvedValue([operation, second])
    mocks.withLock
      .mockRejectedValueOnce(new Error('hasura unavailable'))
      .mockImplementationOnce(async (_scope, callback) => callback({ query: vi.fn() }))
    mocks.getWithClient.mockResolvedValueOnce(second)

    await expect(recoverPendingTableDeletions()).resolves.toEqual({ recovered: 1, failed: 1 })
    expect(mocks.withLock).toHaveBeenCalledTimes(2)
  })

  it('retries pending deletions during runtime and stops cleanly', async () => {
    vi.useFakeTimers()
    const onResult = vi.fn()
    const stop = startTableDeletionRecoveryLoop({
      intervalMs: 100,
      runImmediately: false,
      onResult,
    })

    try {
      await vi.advanceTimersByTimeAsync(100)
      expect(mocks.listPending).toHaveBeenCalledOnce()
      expect(onResult).toHaveBeenCalledWith({ recovered: 1, failed: 0 })

      stop()
      await vi.advanceTimersByTimeAsync(200)
      expect(mocks.listPending).toHaveBeenCalledOnce()
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})
