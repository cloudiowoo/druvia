export type TableAccessMode = 'none' | 'all' | 'owner'
export type AuthenticatedDataOperation = 'select' | 'insert' | 'update' | 'delete'

export interface TableDataAccessPolicy {
  policyVersion?: 1 | 2
  authenticated: {
    select: TableAccessMode
    insert: TableAccessMode
    update: TableAccessMode
    delete: TableAccessMode
    ownerColumn: string | null
    selectConstraint?: {
      type: 'authorization_projection'
      relationshipPath: [string]
      actorColumn: string
      allowColumn: string
    } | null
  }
  anonymous: {
    select: boolean
  }
}

export interface TableDataAccessState {
  projectId: string
  schemaName: string
  tableName: string
  columns: string[]
  policy: TableDataAccessPolicy
  managedState: 'managed' | 'refresh_required' | 'adoption_required' | 'custom' | 'recovery_required' | 'dependency_invalid'
  legacyRoles: string[]
  baselineRevision: number | null
  capabilities: {
    readable: string[]
    insertable: string[]
    updateable: string[]
  }
  effective: TableDataAccessColumnGrants
  drift: {
    addedReadable: string[]
    addedInsertable: string[]
    addedUpdateable: string[]
    removedOrRestricted: string[]
  } | null
  activeOperation: DataAccessPolicyOperationState | null
}

export interface TableDataAccessColumnGrants {
  authenticated: { select: string[]; insert: string[]; update: string[] }
  anonymous: { select: string[] }
}

export interface DataAccessPolicyOperationState {
  operationId: string
  tableName: string
  kind: 'adoption' | 'policy_update' | 'reconcile'
  status: 'preview_ready' | 'applying' | 'recovering' | 'completed' | 'failed' | 'recovery_required' | 'superseded'
  phase: string
  sourceDigest: string
  targetDigest: string | null
  writeDeadlineAt: string | null
  startedAt: string | null
  error: { code: string; message: string } | null
}

export interface DataAccessPolicyPreview {
  operation: DataAccessPolicyOperationState
  projectId: string
  schemaName: string
  tableName: string
  baselineRevision: number | null
  policy: TableDataAccessPolicy
  columnGrants: TableDataAccessColumnGrants
  capabilities: TableDataAccessState['capabilities']
  drift: TableDataAccessState['drift']
}

const OPERATIONS: AuthenticatedDataOperation[] = ['select', 'insert', 'update', 'delete']

export function getAccessModeLabel(mode: TableAccessMode): string {
  const labels: Record<TableAccessMode, string> = {
    none: '关闭',
    all: '全部记录',
    owner: '仅自己的记录',
  }
  return labels[mode]
}

export function requiresOwnerColumn(policy: TableDataAccessPolicy): boolean {
  return OPERATIONS.some((operation) => policy.authenticated[operation] === 'owner')
}

export function hasUnrestrictedWriteAccess(policy: TableDataAccessPolicy): boolean {
  return (['insert', 'update', 'delete'] as AuthenticatedDataOperation[])
    .some((operation) => policy.authenticated[operation] === 'all')
}

export function getTableDataAccessValidationError(
  policy: TableDataAccessPolicy,
  columns: string[]
): string | null {
  if (!requiresOwnerColumn(policy)) return null
  if (!policy.authenticated.ownerColumn) return '请选择所有者字段'
  if (!columns.includes(policy.authenticated.ownerColumn)) return '所有者字段不存在'
  return null
}

export function cloneTableDataAccessPolicy(
  policy: TableDataAccessPolicy
): TableDataAccessPolicy {
  const policyVersion = policy.policyVersion ?? 1
  const { selectConstraint, ...authenticated } = policy.authenticated
  return {
    policyVersion,
    authenticated: policyVersion === 2 && selectConstraint
      ? { ...authenticated, selectConstraint: { ...selectConstraint } }
      : authenticated,
    anonymous: { ...policy.anonymous },
  }
}

export function cloneTableDataAccessColumnGrants(
  grants: TableDataAccessColumnGrants
): TableDataAccessColumnGrants {
  return {
    authenticated: {
      select: [...grants.authenticated.select],
      insert: [...grants.authenticated.insert],
      update: [...grants.authenticated.update],
    },
    anonymous: { select: [...grants.anonymous.select] },
  }
}

export function isDefaultTableDataScope(
  projectSchema: string | null | undefined,
  selectedSchema: string | null | undefined
): boolean {
  return !!projectSchema && selectedSchema === projectSchema
}

export interface TableDetailNavigation {
  tab: 'structure' | 'access'
  schemaName: string | null
  normalizeToDefault: boolean
  consumeDefaultScope: boolean
}

export function resolveTableDetailNavigation(input: {
  tab: string | null
  scope: string | null
  projectSchema: string | null | undefined
  selectedSchema: string | null | undefined
}): TableDetailNavigation {
  const schemaName = input.selectedSchema ?? input.projectSchema ?? null
  if (input.tab !== 'access') {
    return {
      tab: 'structure',
      schemaName,
      normalizeToDefault: false,
      consumeDefaultScope: false,
    }
  }
  if (input.scope === 'default' && input.projectSchema) {
    return {
      tab: 'access',
      schemaName: input.projectSchema,
      normalizeToDefault: input.selectedSchema !== input.projectSchema,
      consumeDefaultScope: true,
    }
  }
  if (input.scope !== null || !isDefaultTableDataScope(input.projectSchema, schemaName)) {
    return {
      tab: 'structure',
      schemaName,
      normalizeToDefault: false,
      consumeDefaultScope: false,
    }
  }
  return {
    tab: 'access',
    schemaName,
    normalizeToDefault: false,
    consumeDefaultScope: false,
  }
}
