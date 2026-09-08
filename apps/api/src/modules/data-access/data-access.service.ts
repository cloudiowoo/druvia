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
  materializeInspectedTableDataAccess,
  type HasuraTableMetadata,
  type InspectedTableDataAccess,
} from './data-access-inspection.js'
import {
  DataAccessInventorySchemaNotFoundError,
  getDataAccessInventory,
} from './data-access-inventory.js'
import { buildProjectDataAccessOverview } from './data-access-overview.js'
import { buildTableColumnCapabilities } from './data-access-column-capabilities.js'
import {
  getManagedPolicy,
  getProjectPolicyOperation,
  listManagedPolicies,
  type ManagedPolicyRecord,
  type PolicyOperationRecord,
} from './data-access-managed-policy.repository.js'
import {
  buildColumnCapabilityDrift,
  classifyManagedPolicyState,
  createPermissionSnapshot,
  isPolicyOperationRecoveryRequired,
} from './data-access-managed-policy.js'
import {
  toOperationState,
  updateManagedTablePolicy,
} from './data-access-policy-operation.service.js'
import type {
  DataAccessColumnCapabilities,
  DataAccessRoleNames,
  ProjectDataAccessOverview,
  TableDataAccessUpdateInput,
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

  const [inventory, metadata, baselines, operation] = await Promise.all([
    loadProjectDataAccessInventory(project.schemaName),
    exportDataAccessMetadata({ projectId, schemaName: project.schemaName }),
    listManagedPolicies(projectId, project.schemaName),
    getProjectPolicyOperation(projectId),
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
    managedPolicies: baselines,
    activeOperation: operation,
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
  const [baseline, operation] = await Promise.all([
    getManagedPolicy(projectId, context.schemaName, tableName),
    getProjectPolicyOperation(projectId),
  ])
  return toState(context, inspected, baseline, operation)
}

export async function updateTableDataAccess(
  projectId: string,
  tableName: string,
  input: TableDataAccessUpdateInput,
  actorId = 'system'
): Promise<TableDataAccessState> {
  return updateManagedTablePolicy(
    projectId,
    tableName,
    input,
    actorId,
    () => getTableDataAccess(projectId, tableName)
  )
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
  inspected: InspectedTableDataAccess,
  baseline: ManagedPolicyRecord | null,
  operation: PolicyOperationRecord | null
): TableDataAccessState {
  const relevantOperation = operation?.tableName === context.tableName ? operation : null
  const sourceCapabilities = baseline?.capabilitiesSnapshot ?? context.capabilities
  const sourceInspected = baseline
    ? inspectTableDataAccessMetadata(context.tableMetadata, context.roles, sourceCapabilities)
    : inspected
  const permissions = sourceInspected.containsWildcard
    ? []
    : sourceInspected.authenticatedState === 'custom' || sourceInspected.anonymousState === 'custom'
      ? []
      : createPermissionSnapshot(materializeInspectedTableDataAccess(
          sourceInspected, context.roles, sourceCapabilities
        ))
  const managedState = classifyManagedPolicyState({
    inspectedState: sourceInspected.authenticatedState === 'custom'
      || sourceInspected.anonymousState === 'custom' ? 'custom' : 'managed',
    hasScopedPermissions: sourceInspected.permissions.length > 0,
    containsWildcard: sourceInspected.containsWildcard,
    currentPermissions: permissions,
    currentCapabilities: context.capabilities,
    baseline,
    recoveryRequired: isPolicyOperationRecoveryRequired(relevantOperation),
  })
  return {
    projectId: context.projectId,
    schemaName: context.schemaName,
    tableName: context.tableName,
    columns: context.capabilities.readableColumns,
    policy: baseline?.policy ?? inspected.policy,
    managedState,
    legacyRoles: inspected.legacyRoles,
    baselineRevision: baseline ? Number(baseline.revision) : null,
    capabilities: {
      readable: context.capabilities.readableColumns,
      insertable: context.capabilities.insertableColumns,
      updateable: context.capabilities.updateableColumns,
    },
    effective: inspected.columnGrants,
    drift: baseline && managedState === 'refresh_required'
      ? buildColumnCapabilityDrift(baseline.capabilitiesSnapshot, context.capabilities)
      : null,
    activeOperation: relevantOperation ? toOperationState(relevantOperation) : null,
  }
}
