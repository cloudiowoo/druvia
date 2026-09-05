import { redactSensitiveText } from '@druvia/shared'
import * as projectService from '../project/project.service.js'
import * as tableService from '../table/table.service.js'
import { hasuraMetadataRequest } from '../realtime/realtime.service.js'
import { resolveDataScopeRole } from './data-scope-role.js'
import {
  materializeTableDataAccessPolicy,
  validateTableDataAccessInput,
} from './data-access-policy.js'
import {
  inspectTableDataAccessMetadata,
  type HasuraTableMetadata,
  type InspectedTableDataAccess,
} from './data-access-inspection.js'
import {
  DataAccessInventorySchemaNotFoundError,
  getDataAccessInventory,
} from './data-access-inventory.js'
import { buildProjectDataAccessOverview } from './data-access-overview.js'
import { withProjectDataAccessMutationLock } from './data-access-mutation-lock.js'
import { applyHasuraMetadataCommands } from './hasura-metadata-bulk.js'
import { buildTableColumnCapabilities } from './data-access-column-capabilities.js'
import type {
  DataAccessColumnCapabilities,
  DataAccessRoleNames,
  ProjectDataAccessOverview,
  TableDataAccessInput,
  TableDataAccessState,
} from './data-access.types.js'

interface HasuraMetadata {
  sources?: Array<{ name?: string; tables?: HasuraTableMetadata[] }>
}

interface DataAccessContext {
  projectId: string
  schemaName: string
  tableName: string
  capabilities: DataAccessColumnCapabilities
  roles: DataAccessRoleNames
  tableMetadata: HasuraTableMetadata | null
}

export class DataAccessNotFoundError extends Error {}
export class DataAccessConflictError extends Error {}
export class DataAccessUpstreamError extends Error {
  readonly operation?: string
  readonly projectId?: string
  readonly schemaName?: string
  readonly tableName?: string
  readonly upstreamCode?: string
  readonly upstreamMessage?: string

  constructor(
    message: string,
    context: {
      operation?: string
      projectId?: string
      schemaName?: string
      tableName?: string
    } = {},
    upstream?: unknown
  ) {
    super(message)
    this.name = 'DataAccessUpstreamError'
    Object.assign(this, context, extractHasuraErrorDetails(upstream))
  }
}

export async function getProjectDataAccessOverview(
  projectId: string
): Promise<ProjectDataAccessOverview> {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) {
    throw new DataAccessNotFoundError('Project or project schema not found')
  }

  const [inventory, metadata] = await Promise.all([
    loadProjectDataAccessInventory(project.schemaName),
    exportDataAccessMetadata({ projectId, schemaName: project.schemaName }),
  ])
  const source = metadata.sources?.find((item) => item.name === 'default')
  if (!source) {
    throw new DataAccessUpstreamError('Default data source is unavailable', {
      operation: 'export_metadata', projectId, schemaName: project.schemaName,
    })
  }

  return buildProjectDataAccessOverview({
    projectId,
    schemaName: project.schemaName,
    runtimeMode: project.dataAccessMode,
    roles: {
      authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
      anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
    },
    inventory,
    tableMetadata: source.tables ?? [],
  })
}

async function loadProjectDataAccessInventory(schemaName: string) {
  try {
    return await getDataAccessInventory(schemaName)
  } catch (error) {
    if (error instanceof DataAccessInventorySchemaNotFoundError) {
      throw new DataAccessNotFoundError('Project or project schema not found')
    }
    throw error
  }
}

export async function getTableDataAccess(
  projectId: string,
  tableName: string
): Promise<TableDataAccessState> {
  const context = await loadDataAccessContext(projectId, tableName)
  const inspected = inspectContext(context)
  return toState(context, inspected)
}

export async function updateTableDataAccess(
  projectId: string,
  tableName: string,
  input: TableDataAccessInput
): Promise<TableDataAccessState> {
  return withProjectDataAccessMutationLock(projectId, () => (
    updateTableDataAccessUnlocked(projectId, tableName, input)
  ))
}

export async function updateTableDataAccessUnlocked(
  projectId: string,
  tableName: string,
  input: TableDataAccessInput
): Promise<TableDataAccessState> {
  const context = await loadDataAccessContext(projectId, tableName)
  const inspected = inspectContext(context)
  if (
    inspected.authenticatedState === 'custom'
    || inspected.anonymousState === 'custom'
  ) {
    throw new DataAccessConflictError(
      'Managed data access metadata contains custom rules and cannot be overwritten'
    )
  }

  validateTableDataAccessInput(input, context.capabilities)
  const tracked = await tableService.trackTableInHasura(context.schemaName, context.tableName)
  if (!tracked) {
    throw new DataAccessUpstreamError('Unable to connect table to data interface', {
      operation: 'track_table', projectId, schemaName: context.schemaName, tableName,
    })
  }

  const desired = materializeTableDataAccessPolicy(input, {
    roles: context.roles,
    capabilities: context.capabilities,
  })
  const table = { schema: context.schemaName, name: context.tableName }
  const commands: Array<{ type: string; args: Record<string, unknown> }> = []

  for (const existing of inspected.existingManaged) {
    commands.push({
      type: `pg_drop_${existing.operation}_permission`,
      args: { source: 'default', table, role: existing.role },
    })
  }
  for (const item of desired) {
    commands.push({
      type: `pg_create_${item.operation}_permission`,
      args: {
        source: 'default',
        table,
        role: item.role,
        permission: item.permission,
      },
    })
  }

  if (commands.length > 0) {
    try {
      await applyHasuraMetadataCommands(commands)
    } catch (error) {
      throw new DataAccessUpstreamError('Unable to update data access metadata', {
        operation: 'update_permissions',
        projectId,
        schemaName: context.schemaName,
        tableName,
      }, error)
    }
  }

  return {
    projectId,
    schemaName: context.schemaName,
    tableName,
    columns: context.capabilities.readableColumns,
    policy: input,
    managedState: 'managed',
    legacyRoles: inspected.legacyRoles,
  }
}

async function loadDataAccessContext(
  projectId: string,
  tableName: string
): Promise<DataAccessContext> {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) {
    throw new DataAccessNotFoundError('Project or project schema not found')
  }

  const table = await tableService.getTableMetadata(project.schemaName, tableName)
  if (!table) {
    throw new DataAccessNotFoundError('Table not found')
  }

  const metadata = await exportDataAccessMetadata({
    projectId,
    schemaName: project.schemaName,
    tableName,
  })
  const source = metadata.sources?.find((item) => item.name === 'default')
  if (!source) {
    throw new DataAccessUpstreamError('Default data source is unavailable', {
      operation: 'export_metadata', projectId, schemaName: project.schemaName, tableName,
    })
  }
  const tableMetadata = source?.tables?.find(
    (item) => item.table.schema === project.schemaName && item.table.name === tableName
  ) ?? null

  return {
    projectId,
    schemaName: project.schemaName,
    tableName,
    capabilities: buildTableColumnCapabilities(table.columns),
    roles: {
      authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
      anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
    },
    tableMetadata,
  }
}

async function exportDataAccessMetadata(context: {
  projectId: string
  schemaName: string
  tableName?: string
}): Promise<HasuraMetadata> {
  try {
    return await hasuraMetadataRequest<HasuraMetadata>('export_metadata', {})
  } catch (error) {
    throw new DataAccessUpstreamError('Unable to read data access metadata', {
      operation: 'export_metadata',
      ...context,
    }, error)
  }
}

function extractHasuraErrorDetails(error: unknown): {
  upstreamCode?: string
  upstreamMessage?: string
} {
  if (!(error instanceof Error)) return {}
  const jsonStart = error.message.indexOf('{')
  if (jsonStart < 0) return { upstreamMessage: sanitizeUpstreamMessage(error.message) }
  try {
    const payload = JSON.parse(error.message.slice(jsonStart)) as Record<string, unknown>
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
        ? payload.message
        : undefined
    return {
      ...(typeof payload.code === 'string' ? { upstreamCode: payload.code } : {}),
      ...(message ? { upstreamMessage: sanitizeUpstreamMessage(message) } : {}),
    }
  } catch {
    return { upstreamMessage: sanitizeUpstreamMessage(error.message) }
  }
}

function sanitizeUpstreamMessage(message: string): string {
  return redactSensitiveText(message)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

function inspectContext(context: DataAccessContext): InspectedTableDataAccess {
  return inspectTableDataAccessMetadata(
    context.tableMetadata,
    context.roles,
    context.capabilities
  )
}

function toState(
  context: DataAccessContext,
  inspected: InspectedTableDataAccess
): TableDataAccessState {
  return {
    projectId: context.projectId,
    schemaName: context.schemaName,
    tableName: context.tableName,
    columns: context.capabilities.readableColumns,
    policy: inspected.policy,
    managedState: inspected.authenticatedState === 'custom'
      || inspected.anonymousState === 'custom'
      ? 'custom'
      : 'managed',
    legacyRoles: inspected.legacyRoles,
  }
}
