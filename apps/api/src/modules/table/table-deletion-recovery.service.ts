import { createApiLogger } from '../../lib/logger.js'
import { withProjectDataAccessMutationLock } from '../data-access/data-access-mutation-lock.js'
import { completePendingTableDeletion } from './table.service.js'
import {
  getTableDeletionWithClient,
  listPendingTableDeletions,
} from './table-deletion-outbox.repository.js'

const logger = createApiLogger({ module: 'table-deletion-recovery' })

export interface TableDeletionRecoveryResult {
  recovered: number
  failed: number
}

interface TableDeletionRecoveryLoopOptions {
  intervalMs?: number
  runImmediately?: boolean
  onResult?: (result: TableDeletionRecoveryResult) => void
}

export async function recoverPendingTableDeletions(): Promise<TableDeletionRecoveryResult> {
  const pending = await listPendingTableDeletions()
  let recovered = 0
  let failed = 0

  for (const operation of pending) {
    try {
      await withProjectDataAccessMutationLock(
        operation.lockScope,
        async (client) => {
          const current = await getTableDeletionWithClient(client, operation.operationId)
          if (!current) return
          await completePendingTableDeletion(client, current)
        },
        {
          globalMode: 'exclusive',
          purpose: 'table_delete_recovery',
          operationId: operation.operationId,
        }
      )
      recovered += 1
    } catch (error) {
      failed += 1
      logger.warn('pending table deletion recovery failed', {
        operationId: operation.operationId,
        lockScope: operation.lockScope,
        schemaName: operation.schemaName,
        tableName: operation.tableName,
      }, error)
    }
  }

  return { recovered, failed }
}

export function startTableDeletionRecoveryLoop(
  options: TableDeletionRecoveryLoopOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? 30_000
  let stopped = false
  let running = false

  const run = async () => {
    if (stopped || running) return
    running = true
    try {
      options.onResult?.(await recoverPendingTableDeletions())
    } catch (error) {
      logger.warn('table deletion recovery cycle failed', {}, error)
    } finally {
      running = false
    }
  }

  if (options.runImmediately !== false) void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
