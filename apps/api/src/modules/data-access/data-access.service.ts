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
import type {
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
  columns: string[]
  roles: DataAccessRoleNames
  tableMetadata: HasuraTableMetadata | null
}

export class DataAccessNotFoundError extends Error {}
export class DataAccessConflictError extends Error {}
export class DataAccessUpstreamError extends Error {}

export async function getProjectDataAccessOverview(
  projectId: string
): Promise<ProjectDataAccessOverview> {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) {
    throw new DataAccessNotFoundError('Project or project schema not found')
  }

  const [inventory, metadata] = await Promise.all([
    loadProjectDataAccessInventory(project.schemaName),
    exportDataAccessMetadata(),
  ])
  const source = metadata.sources?.find((item) => item.name === 'default')
  if (!source) {
    throw new DataAccessUpstreamError('Default data source is unavailable')
  }

  return buildProjectDataAccessOverview({
    projectId,
    schemaName: project.schemaName,
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

  validateTableDataAccessInput(input, context.columns)
  const tracked = await tableService.trackTableInHasura(context.schemaName, context.tableName)
  if (!tracked) {
    throw new DataAccessUpstreamError('Unable to connect table to data interface')
  }

  const desired = materializeTableDataAccessPolicy(input, {
    roles: context.roles,
    columns: context.columns,
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
      await hasuraMetadataRequest('bulk_atomic', commands as never)
    } catch (error) {
      throw new DataAccessUpstreamError(
        error instanceof Error ? error.message : 'Unable to update data access metadata'
      )
    }
  }

  return {
    projectId,
    schemaName: context.schemaName,
    tableName,
    columns: context.columns,
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

  const metadata = await exportDataAccessMetadata()
  const source = metadata.sources?.find((item) => item.name === 'default')
  if (!source) {
    throw new DataAccessUpstreamError('Default data source is unavailable')
  }
  const tableMetadata = source?.tables?.find(
    (item) => item.table.schema === project.schemaName && item.table.name === tableName
  ) ?? null

  return {
    projectId,
    schemaName: project.schemaName,
    tableName,
    columns: table.columns.map((column) => column.name),
    roles: {
      authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
      anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
    },
    tableMetadata,
  }
}

async function exportDataAccessMetadata(): Promise<HasuraMetadata> {
  try {
    return await hasuraMetadataRequest<HasuraMetadata>('export_metadata', {})
  } catch (error) {
    throw new DataAccessUpstreamError(
      error instanceof Error ? error.message : 'Unable to read data access metadata'
    )
  }
}

function inspectContext(context: DataAccessContext): InspectedTableDataAccess {
  return inspectTableDataAccessMetadata(
    context.tableMetadata,
    context.roles,
    context.columns
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
    columns: context.columns,
    policy: inspected.policy,
    managedState: inspected.authenticatedState === 'custom'
      || inspected.anonymousState === 'custom'
      ? 'custom'
      : 'managed',
    legacyRoles: inspected.legacyRoles,
  }
}
