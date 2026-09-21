export const API_SUPPORTED_MIGRATION_CEILING = 29
export const API_REQUIRED_MIGRATION_FLOOR = 29

interface MigrationVersionReader {
  query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>
}

export async function assertSupportedDatabaseMigrationVersion(
  reader: MigrationVersionReader,
  ceiling = API_SUPPORTED_MIGRATION_CEILING,
  floor = API_REQUIRED_MIGRATION_FLOOR
): Promise<void> {
  const result = await reader.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0)::int AS version FROM druvia_schema_versions'
  )
  const version = result.rows[0]?.version ?? 0
  if (version < floor) {
    throw new Error(
      `Database migration ${version} is older than this API requires (floor ${floor})`
    )
  }
  if (version > ceiling) {
    throw new Error(
      `Database migration ${version} is newer than this API supports (ceiling ${ceiling})`
    )
  }
}
