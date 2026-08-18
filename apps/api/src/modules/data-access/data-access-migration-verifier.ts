import { createClient, type Client } from 'graphql-ws'
import WebSocket from 'ws'
import type { ProjectDataAccessMode } from '@druvia/shared'
import type { ApiKeyIdentity, ProjectJwtUser } from '../../middleware/auth.js'
import { config } from '../../config/index.js'
import { materializeTableDataAccessPolicy } from './data-access-policy.js'
import { canonicalizeMigrationValue, digestMigrationValue } from './data-access-migration-plan.js'
import { resolveProjectDataExecutionContext, type ProjectDataExecutionContext } from './project-data-actor.js'
import { resolveRealtimeExecutionContext, type RealtimeExecutionContext } from '../realtime/realtime-actor.js'
import { issueInternalRealtimeAccessToken } from '../realtime/realtime-token.service.js'
import type { DataAccessRoleNames } from './data-access.types.js'
import type {
  DataAccessMigrationOperation,
  ProjectDataAccessMigrationPlan,
  ProjectDataAccessMigrationSnapshot,
} from './data-access-migration.types.js'

const VERIFICATION_TIMEOUT_MS = 5_000
const SCHEMA_PROBE = `query DruviaMigrationSchemaProbe {
  __schema {
    queryType { fields { name } }
    mutationType { fields { name } }
    subscriptionType { fields { name } }
  }
}`

export class DataAccessMigrationVerificationError extends Error {
  readonly code = 'DATA_ACCESS_MIGRATION_VERIFICATION_FAILED'
}

export function verifyMigrationMetadata(input: {
  currentSnapshot: ProjectDataAccessMigrationSnapshot
  sourceSnapshot: ProjectDataAccessMigrationSnapshot
  plan: ProjectDataAccessMigrationPlan
  roles: DataAccessRoleNames
  stage: 'prepared' | 'legacy_removed'
}): void {
  if (input.currentSnapshot.externalScopedRoleBindings.length > 0) {
    throw new DataAccessMigrationVerificationError('Scoped role exists outside the project schema')
  }
  if (input.currentSnapshot.unsupportedApiBindings.length > 0) {
    throw new DataAccessMigrationVerificationError('Unsupported API actor binding exists')
  }

  const relevantRoles = new Set(['user', 'anonymous', input.roles.authenticated, input.roles.anonymous])
  const expectedPermissions = input.currentSnapshot.tables.flatMap((currentTable) => {
    const sourceTable = input.sourceSnapshot.tables.find((table) => table.tableName === currentTable.tableName)
    const target = input.plan.targetPolicies.find((item) => item.tableName === currentTable.tableName)
    if (!sourceTable || !target) {
      throw new DataAccessMigrationVerificationError(`Unexpected tracked table: ${currentTable.tableName}`)
    }
    const legacyPermissions = input.stage === 'prepared'
      ? sourceTable.permissions.filter((permission) => permission.role === 'user' || permission.role === 'anonymous')
      : []
    return [
      ...legacyPermissions,
      ...materializeTableDataAccessPolicy(target.policy, {
        roles: input.roles,
        columns: currentTable.columns,
      }),
    ].map((permission) => ({ tableName: currentTable.tableName, ...permission }))
  }).sort(compareVerificationPermission)
  const currentPermissions = input.currentSnapshot.tables.flatMap((table) => table.permissions
    .filter((permission) => relevantRoles.has(permission.role))
    .map((permission) => ({ tableName: table.tableName, ...permission })))
    .sort(compareVerificationPermission)

  const expectedKeys = expectedPermissions.map(verificationPermissionKey)
  const currentKeys = currentPermissions.map(verificationPermissionKey)
  if (!equalMigrationValue(currentKeys, expectedKeys)) {
    const missing = expectedKeys.filter((key) => !currentKeys.includes(key))
    const unexpected = currentKeys.filter((key) => !expectedKeys.includes(key))
    throw new DataAccessMigrationVerificationError(
      `Project permission metadata does not match the migration plan (missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'})`
    )
  }

  for (const target of input.plan.targetPolicies) {
    const current = input.currentSnapshot.tables.find((table) => table.tableName === target.tableName)
    if (!current) throw new DataAccessMigrationVerificationError(`Tracked table is missing: ${target.tableName}`)
    const expected = materializeTableDataAccessPolicy(target.policy, {
      roles: input.roles,
      columns: current.columns,
    })
    for (const permission of expected) {
      const matches = current.permissions.filter((item) => (
        item.role === permission.role
        && item.operation === permission.operation
        && equalPermissionValue(item.permission, permission.permission)
      ))
      if (matches.length !== 1) {
        throw new DataAccessMigrationVerificationError(
          `Expected scoped permission is missing or duplicated: ${target.tableName}.${permission.operation}`
        )
      }
    }
  }

  for (const drop of input.plan.legacyDrops) {
    const current = input.currentSnapshot.tables.find((table) => table.tableName === drop.tableName)
    const matches = current?.permissions.filter((item) => (
      item.role === drop.role && item.operation === drop.operation
    )) ?? []
    if (input.stage === 'legacy_removed') {
      if (matches.length > 0) {
        throw new DataAccessMigrationVerificationError(`Legacy permission remains: ${drop.tableName}.${drop.operation}`)
      }
      continue
    }

    const source = input.sourceSnapshot.tables.find((table) => table.tableName === drop.tableName)
      ?.permissions.find((item) => item.role === drop.role && item.operation === drop.operation)
    if (!source || matches.length !== 1 || !equalPermissionValue(matches[0].permission, source.permission)) {
      throw new DataAccessMigrationVerificationError(`Legacy permission drifted: ${drop.tableName}.${drop.operation}`)
    }
  }
}

function compareVerificationPermission(
  left: { tableName: string; role: string; operation: DataAccessMigrationOperation },
  right: { tableName: string; role: string; operation: DataAccessMigrationOperation }
): number {
  return `${left.tableName}:${left.role}:${left.operation}`
    .localeCompare(`${right.tableName}:${right.role}:${right.operation}`)
}

function verificationPermissionKey(permission: {
  tableName: string
  role: string
  operation: DataAccessMigrationOperation
  permission: Record<string, unknown>
}): string {
  return `${permission.tableName}:${permission.role}:${permission.operation}:${
    digestMigrationValue(normalizePermissionForVerification(permission.permission))
  }`
}

function equalPermissionValue(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return equalMigrationValue(
    normalizePermissionForVerification(left),
    normalizePermissionForVerification(right)
  )
}

function normalizePermissionForVerification(permission: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...permission }
  if (normalized.allow_aggregations === false) delete normalized.allow_aggregations
  return normalized
}

export async function verifyMigrationHttpVisibility(input: {
  endpoint?: string
  adminSecret?: string
  schemaName: string
  plan: ProjectDataAccessMigrationPlan
  snapshot: ProjectDataAccessMigrationSnapshot
  actor: 'authenticated' | 'anonymous'
  context: ProjectDataExecutionContext
  forbiddenRootFields?: string[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<void> {
  const endpoint = (input.endpoint ?? config.hasura.endpoint).replace(/\/$/, '')
  const adminSecret = input.adminSecret ?? config.hasura.adminSecret
  if (!adminSecret) throw new DataAccessMigrationVerificationError('Hasura verifier is unavailable')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? VERIFICATION_TIMEOUT_MS)
  try {
    const response = await (input.fetchImpl ?? fetch)(`${endpoint}/v1/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': adminSecret,
        'x-hasura-default-schema': input.schemaName,
        'x-hasura-role': input.context.role,
        ...input.context.sessionVariables,
      },
      body: JSON.stringify({ query: SCHEMA_PROBE }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new DataAccessMigrationVerificationError(`Hasura schema probe failed with HTTP ${response.status}`)
    }
    const payload = await response.json() as {
      data?: { __schema?: IntrospectionSchema }
      errors?: unknown[]
    }
    if (payload.errors?.length || !payload.data?.__schema) {
      throw new DataAccessMigrationVerificationError('Hasura schema probe returned an invalid response')
    }
    assertVisibleRoots(input, payload.data.__schema)
  } catch (error) {
    if (error instanceof DataAccessMigrationVerificationError) throw error
    throw new DataAccessMigrationVerificationError(
      error instanceof Error && error.name === 'AbortError'
        ? 'Hasura schema probe timed out'
        : 'Hasura schema probe is unavailable'
    )
  } finally {
    clearTimeout(timer)
  }
}

interface IntrospectionSchema {
  queryType: { fields: Array<{ name: string }> } | null
  mutationType: { fields: Array<{ name: string }> } | null
  subscriptionType: { fields: Array<{ name: string }> } | null
}

function assertVisibleRoots(
  input: Parameters<typeof verifyMigrationHttpVisibility>[0],
  schema: IntrospectionSchema
): void {
  const visible = {
    query: new Set(schema.queryType?.fields.map((field) => field.name) ?? []),
    mutation: new Set(schema.mutationType?.fields.map((field) => field.name) ?? []),
    subscription: new Set(schema.subscriptionType?.fields.map((field) => field.name) ?? []),
  }
  for (const target of input.plan.targetPolicies) {
    const table = input.snapshot.tables.find((item) => item.tableName === target.tableName)
    if (!table) throw new DataAccessMigrationVerificationError(`Snapshot table is missing: ${target.tableName}`)
    const roots = tableRootFields(input.snapshot.schemaName, table)
    const permissions = table.permissions.filter((permission) => permission.role === input.context.role)
    const select = permissions.find((permission) => permission.operation === 'select')

    assertRoot(visible.query, roots.select, !!select)
    assertRoot(visible.query, roots.selectAggregate, select?.permission.allow_aggregations === true)
    assertRoot(visible.mutation, roots.insert, permissions.some((permission) => permission.operation === 'insert'))
    assertRoot(visible.mutation, roots.update, permissions.some((permission) => permission.operation === 'update'))
    assertRoot(visible.mutation, roots.delete, permissions.some((permission) => permission.operation === 'delete'))
    // Hasura exposes subscription roots from select permissions. The Druvia
    // Realtime capability flag controls product use, not schema generation.
    assertRoot(visible.subscription, roots.select, !!select)
  }
  for (const root of input.forbiddenRootFields ?? []) {
    if (visible.query.has(root) || visible.mutation.has(root) || visible.subscription.has(root)) {
      throw new DataAccessMigrationVerificationError(`Unexpected cross-project GraphQL root: ${root}`)
    }
  }
}

function tableRootFields(
  schemaName: string,
  table: ProjectDataAccessMigrationSnapshot['tables'][number]
) {
  const custom = table.graphqlNaming.customRootFields
  const base = table.graphqlNaming.customName ?? `${schemaName}_${table.tableName}`
  return {
    select: custom.select ?? base,
    selectAggregate: custom.select_aggregate ?? `${base}_aggregate`,
    insert: custom.insert ?? `insert_${base}`,
    update: custom.update ?? `update_${base}`,
    delete: custom.delete ?? `delete_${base}`,
  }
}

function assertRoot(visible: Set<string>, root: string, expected: boolean): void {
  if (expected && !visible.has(root)) {
    throw new DataAccessMigrationVerificationError(`Expected GraphQL root is missing: ${root}`)
  }
  if (!expected && visible.has(root)) {
    throw new DataAccessMigrationVerificationError(`Unexpected GraphQL root is visible: ${root}`)
  }
}

export interface DisposableRealtimeConnection {
  dispose(): Promise<void> | void
}

export async function verifyMigrationRealtimeActors(input: {
  endpoint?: string
  projectId: string
  runtimeMode: ProjectDataAccessMode
  issueToken?: (input: { projectId: string; context: RealtimeExecutionContext }) => { token: string }
  openConnection?: (url: string, token: string, timeoutMs: number) => Promise<DisposableRealtimeConnection>
  resolveContext?: (actor: ProjectJwtUser | ApiKeyIdentity) => RealtimeExecutionContext
  timeoutMs?: number
}): Promise<void> {
  const actors = syntheticActors(input.projectId)
  const openConnections: DisposableRealtimeConnection[] = []
  try {
    for (const actor of actors) {
      const context = input.resolveContext?.(actor) ?? resolveRealtimeExecutionContext({
        projectId: input.projectId, runtimeMode: input.runtimeMode, actor,
      })
      const token = (input.issueToken ?? issueInternalRealtimeAccessToken)({
        projectId: input.projectId,
        context,
      }).token
      const connection = await (input.openConnection ?? openInternalRealtimeConnection)(
        createInternalHasuraWebSocketUrl(input.endpoint ?? config.hasura.endpoint),
        token,
        input.timeoutMs ?? VERIFICATION_TIMEOUT_MS
      )
      openConnections.push(connection)
    }
  } finally {
    await Promise.allSettled(openConnections.map((connection) => connection.dispose()))
  }
}

export function createInternalHasuraWebSocketUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/v1/graphql'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function buildActiveRuntimeHttpContexts(
  projectId: string,
  runtimeMode: ProjectDataAccessMode
): Array<{ actor: 'authenticated' | 'anonymous'; context: ProjectDataExecutionContext }> {
  const [projectUser, apiKey] = syntheticActors(projectId)
  return [
    {
      actor: 'authenticated',
      context: resolveProjectDataExecutionContext({ projectId, runtimeMode, actor: projectUser }),
    },
    {
      actor: 'anonymous',
      context: resolveProjectDataExecutionContext({ projectId, runtimeMode, actor: apiKey }),
    },
  ]
}

async function openInternalRealtimeConnection(
  url: string,
  token: string,
  timeoutMs: number
): Promise<DisposableRealtimeConnection> {
  let settled = false
  let resolveAck!: () => void
  let rejectAck!: (error: unknown) => void
  const acknowledged = new Promise<void>((resolve, reject) => {
    resolveAck = resolve
    rejectAck = reject
  })
  const finish = (error?: unknown) => {
    if (settled) return
    settled = true
    error ? rejectAck(error) : resolveAck()
  }
  const client: Client = createClient({
    url,
    webSocketImpl: WebSocket,
    lazy: false,
    retryAttempts: 0,
    connectionAckWaitTimeout: timeoutMs,
    connectionParams: { headers: { Authorization: `Bearer ${token}` } },
    onNonLazyError: (error) => finish(error),
    on: {
      connected: () => finish(),
      closed: (event) => finish(new Error(`Realtime connection closed: ${
        typeof event === 'object' && event && 'code' in event ? String(event.code) : 'unknown'
      }`)),
      error: (error) => finish(error),
    },
  })
  try {
    await acknowledged
    return { dispose: () => client.dispose() }
  } catch (error) {
    await client.dispose()
    throw new DataAccessMigrationVerificationError(
      error instanceof Error ? `Realtime verification failed: ${error.message}` : 'Realtime verification failed'
    )
  }
}

function syntheticActors(projectId: string): [ProjectJwtUser, ApiKeyIdentity] {
  return [
    {
      kind: 'project_user', sub: `migration-probe:${projectId}`, projectId,
      authType: 'project_user', role: 'authenticated', provider: 'internal_verifier',
    },
    { kind: 'apikey', projectId, role: 'anon' },
  ]
}

function equalMigrationValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeMigrationValue(left)) === JSON.stringify(canonicalizeMigrationValue(right))
}
