import { query, queryOne } from '../../db/index.js'

export interface DataAccessInventoryTable {
  tableName: string
  columns: string[]
  insertableColumns: string[]
  updateableColumns: string[]
  realtimeEnabled: boolean
}

interface InventoryRow {
  table_name: string
  columns: string[]
  insertable_columns: string[]
  updateable_columns: string[]
  realtime_enabled: boolean
}

interface InventoryRelations {
  schema_exists: boolean
  metadata_exists: boolean
}

export class DataAccessInventorySchemaNotFoundError extends Error {}

export async function getDataAccessInventory(
  schemaName: string
): Promise<DataAccessInventoryTable[]> {
  validateSchemaName(schemaName)

  const relations = await queryOne<InventoryRelations>(
    `SELECT to_regnamespace($1) IS NOT NULL AS schema_exists,
            to_regclass($2) IS NOT NULL AS metadata_exists`,
    [schemaName, `"${schemaName}"."_meta_tables"`]
  )
  if (!relations?.schema_exists) {
    throw new DataAccessInventorySchemaNotFoundError('Schema not found')
  }

  const metadataJoin = relations.metadata_exists
    ? `LEFT JOIN "${schemaName}"._meta_tables m ON m.table_name = t.table_name`
    : ''
  const realtimeExpression = relations.metadata_exists
    ? 'COALESCE(m.realtime_enabled, false)'
    : 'false'

  const rows = await query<InventoryRow>(
    `SELECT t.table_name,
            array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns,
            COALESCE(
              array_agg(c.column_name::text ORDER BY c.ordinal_position)
                FILTER (WHERE c.is_generated = 'NEVER'
                  AND c.identity_generation IS DISTINCT FROM 'ALWAYS'),
              ARRAY[]::text[]
            ) AS insertable_columns,
            COALESCE(
              array_agg(c.column_name::text ORDER BY c.ordinal_position)
                FILTER (WHERE c.is_generated = 'NEVER'
                  AND c.identity_generation IS DISTINCT FROM 'ALWAYS'),
              ARRAY[]::text[]
            ) AS updateable_columns,
            ${realtimeExpression} AS realtime_enabled
     FROM information_schema.tables t
     JOIN information_schema.columns c
       ON c.table_schema = t.table_schema AND c.table_name = t.table_name
     ${metadataJoin}
     WHERE t.table_schema = $1
       AND t.table_type = 'BASE TABLE'
       AND t.table_name NOT LIKE '\\_%'
     GROUP BY t.table_name${relations.metadata_exists ? ', m.realtime_enabled' : ''}
     ORDER BY t.table_name`,
    [schemaName]
  )

  return rows.map((row) => ({
    tableName: row.table_name,
    columns: row.columns,
    insertableColumns: row.insertable_columns,
    updateableColumns: row.updateable_columns,
    realtimeEnabled: row.realtime_enabled,
  }))
}

function validateSchemaName(schemaName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid schema name')
  }
}
