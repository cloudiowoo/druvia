import type { PoolClient } from 'pg'
import { query } from '../../db/index.js'

interface TableDeletionOutboxRow {
  operation_id: string
  lock_scope: string
  schema_name: string
  table_name: string
  status: 'pending'
  attempts: number
  last_error: string | null
  created_at: Date
  updated_at: Date
}

export interface TableDeletionOutboxRecord {
  operationId: string
  lockScope: string
  schemaName: string
  tableName: string
  status: 'pending'
  attempts: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

interface Queryable {
  query: PoolClient['query']
}

export async function enqueueTableDeletion(
  client: Queryable,
  input: Pick<TableDeletionOutboxRecord, 'operationId' | 'lockScope' | 'schemaName' | 'tableName'>
): Promise<TableDeletionOutboxRecord> {
  const result = await client.query<TableDeletionOutboxRow>(
    `INSERT INTO druvia_table_deletion_outbox (
       operation_id, lock_scope, schema_name, table_name
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (schema_name, table_name) DO UPDATE
       SET updated_at = NOW()
     RETURNING *`,
    [input.operationId, input.lockScope, input.schemaName, input.tableName]
  )
  if (!result.rows[0]) throw new Error('Failed to persist table deletion recovery state')
  return toRecord(result.rows[0])
}

export async function getTableDeletionWithClient(
  client: Queryable,
  operationId: string
): Promise<TableDeletionOutboxRecord | null> {
  const result = await client.query<TableDeletionOutboxRow>(
    'SELECT * FROM druvia_table_deletion_outbox WHERE operation_id = $1',
    [operationId]
  )
  return result.rows[0] ? toRecord(result.rows[0]) : null
}

export async function listPendingTableDeletions(): Promise<TableDeletionOutboxRecord[]> {
  const rows = await query<TableDeletionOutboxRow>(
    `SELECT * FROM druvia_table_deletion_outbox
     WHERE status = 'pending'
     ORDER BY created_at, operation_id`
  )
  return rows.map(toRecord)
}

export async function markTableDeletionAttemptFailed(
  client: Queryable,
  operationId: string
): Promise<void> {
  await client.query(
    `UPDATE druvia_table_deletion_outbox
     SET attempts = attempts + 1,
         last_error = 'TABLE_UNTRACK_FAILED',
         updated_at = NOW()
     WHERE operation_id = $1`,
    [operationId]
  )
}

export async function deleteTableDeletionOutbox(
  client: Queryable,
  operationId: string
): Promise<void> {
  await client.query(
    'DELETE FROM druvia_table_deletion_outbox WHERE operation_id = $1',
    [operationId]
  )
}

function toRecord(row: TableDeletionOutboxRow): TableDeletionOutboxRecord {
  return {
    operationId: row.operation_id,
    lockScope: row.lock_scope,
    schemaName: row.schema_name,
    tableName: row.table_name,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
