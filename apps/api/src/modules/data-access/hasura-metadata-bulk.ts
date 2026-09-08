import {
  hasuraMetadataRequest,
  hasuraMetadataRequestWithOptions,
} from '../realtime/realtime.service.js'
import type { DataAccessOperation, MaterializedDataPermission } from './data-access.types.js'

export interface HasuraMetadataCommand {
  type: string
  args: Record<string, unknown>
}

export class HasuraMetadataMutationUncertainError extends Error {
  constructor(readonly originalError: unknown) {
    super(`Hasura metadata mutation outcome is unknown: ${
      originalError instanceof Error ? originalError.message : 'unknown failure'
    }`)
    this.name = 'HasuraMetadataMutationUncertainError'
  }
}

interface HasuraMetadataPermissionEntry {
  role: string
  permission: Record<string, unknown>
}

interface HasuraMetadataTable {
  table: { schema: string; name: string }
  select_permissions?: HasuraMetadataPermissionEntry[]
  insert_permissions?: HasuraMetadataPermissionEntry[]
  update_permissions?: HasuraMetadataPermissionEntry[]
  delete_permissions?: HasuraMetadataPermissionEntry[]
  [key: string]: unknown
}

interface HasuraMetadataSource {
  name: string
  tables?: HasuraMetadataTable[]
  [key: string]: unknown
}

export interface HasuraMetadataDocument {
  sources?: HasuraMetadataSource[]
  [key: string]: unknown
}

interface TablePermissionReplacement {
  sourceName: string
  schemaName: string
  tableName: string
  scopedRoles: string[]
  permissions: MaterializedDataPermission[]
}

interface ApplyTablePermissionReplacement extends TablePermissionReplacement {
  resourceVersion: bigint
  allowInconsistentMetadata: boolean
  timeoutMs?: number
}

export async function applyHasuraMetadataCommands(
  commands: HasuraMetadataCommand[],
  options: {
    resourceVersion?: bigint
    timeoutMs?: number
    beforeFallback?: () => Promise<void>
  } = {}
): Promise<void> {
  if (commands.length === 0) return
  const { beforeFallback, ...requestOptions } = options
  const request = requestOptions.resourceVersion === undefined
    ? (type: string) => hasuraMetadataRequest(type, commands as never)
    : (type: string) => hasuraMetadataRequestWithOptions(type, commands, requestOptions)
  try {
    await request('bulk_atomic')
  } catch (error) {
    if (!isUnsupportedAtomicCommand(error)) throw error
    await beforeFallback?.()
    try {
      await request('bulk')
    } catch (fallbackError) {
      throw new HasuraMetadataMutationUncertainError(fallbackError)
    }
  }
}

export function buildMetadataWithTablePermissions<T extends HasuraMetadataDocument>(
  metadata: T,
  input: TablePermissionReplacement
): T {
  const replaced = structuredClone(metadata)
  const source = replaced.sources?.find((item) => item.name === input.sourceName)
  const table = source?.tables?.find(
    (item) => item.table.schema === input.schemaName && item.table.name === input.tableName
  )
  if (!table) throw new Error('Hasura table metadata is unavailable')

  const scopedRoles = new Set(input.scopedRoles)
  for (const operation of ['select', 'insert', 'update', 'delete'] as DataAccessOperation[]) {
    const key = `${operation}_permissions` as const
    const preserved = (table[key] ?? []).filter((item) => !scopedRoles.has(item.role))
    const managed = input.permissions
      .filter((item) => item.operation === operation)
      .map((item) => ({ role: item.role, permission: item.permission }))
      .sort((left, right) => left.role.localeCompare(right.role))
    const permissions = [...preserved, ...managed]
    if (permissions.length > 0) table[key] = permissions
    else delete table[key]
  }
  return replaced
}

export async function replaceHasuraTablePermissions(
  metadata: HasuraMetadataDocument,
  input: ApplyTablePermissionReplacement
): Promise<void> {
  const replaced = buildMetadataWithTablePermissions(metadata, input)
  await hasuraMetadataRequestWithOptions('replace_metadata', {
    allow_inconsistent_metadata: input.allowInconsistentMetadata,
    metadata: replaced,
  }, {
    resourceVersion: input.resourceVersion,
    timeoutMs: input.timeoutMs ?? 30_000,
  })
}

function isUnsupportedAtomicCommand(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Bulk atomic does not support this command')
}
