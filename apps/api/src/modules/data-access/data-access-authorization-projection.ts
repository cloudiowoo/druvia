import type { PoolClient } from 'pg'
import { stableDigest } from './data-access-managed-policy.js'

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/
const COLUMN_TYPES = new Set(['uuid', 'boolean', 'text', 'jsonb'])

export interface AuthorizationProjectionContract {
  contractVersion: 1 | 2
  policyVersion: 2
  view: {
    name: string
    projectionMode: 'sparse_allow_list'
    key: string[]
    columns: Record<string, 'uuid' | 'boolean' | 'text' | 'jsonb'>
    environmentColumn?: string
    clientPermissions: { select: false; insert: false; update: false; delete: false }
  }
  relationships: AuthorizationProjectionRelationship[]
}

export interface AuthorizationProjectionRelationship {
  table: string
  name: string
  type: 'object'
  mapping: Record<string, string>
  ownerColumn: string
  actorColumn: string
  allowColumn: string
}

export interface ProjectionCatalogColumn {
  name: string
  type: string
  nullable: boolean
}

export interface ProjectionRelationDependency {
  schemaName: string
  relationName: string
  relationKind: string
  view: {
    owner: string
    relationOptions: string[]
    publicPrivileges: string[]
    publicColumnPrivileges: string[]
    definitionDigest: string
    columns: ProjectionCatalogColumn[]
  } | null
}

export interface AuthorizationProjectionCatalog {
  relationKind: string
  owner: string
  securityBarrier: boolean
  securityInvoker: boolean
  relationOptions: string[]
  publicPrivileges: string[]
  publicColumnPrivileges: string[]
  definition: string
  columns: ProjectionCatalogColumn[]
  projectionKeyUnique: boolean
  functionDependencies: Array<{ schemaName: string; identity: string }>
  relationDependencies: ProjectionRelationDependency[]
  sourceTables: Array<{ table: string; columns: ProjectionCatalogColumn[] }>
}

export interface AuthorizationProjectionMetadata {
  viewTracked: boolean
  viewScopedPermissions: string[]
  trackedTables: string[]
  relationships: Array<{
    table: string
    name: string
    type: 'object' | 'array'
    using: Record<string, unknown>
    targetSchema: string
    targetTable: string
    mapping: Record<string, string>
  }>
}

export interface AuthorizationProjectionDependencySnapshot {
  schemaName: string
  contract: AuthorizationProjectionContract
  view: {
    name: string
    owner: string
    securityBarrier: true
    securityInvoker: false
    relationOptions: string[]
    publicPrivileges: string[]
    publicColumnPrivileges: string[]
    definitionDigest: string
    columns: ProjectionCatalogColumn[]
    key: string[]
    tracked: boolean
    relationDependencies: ProjectionRelationDependency[]
  }
  relationships: Array<{
    table: string
    name: string
    type: 'object'
    using: Record<string, unknown>
    mapping: Record<string, string>
    ownerColumn: string
    actorColumn: string
    allowColumn: string
  }>
  digest: string
}

export class AuthorizationProjectionValidationError extends Error {}

export async function loadAuthorizationProjectionDependencies(input: {
  client: Pick<PoolClient, 'query'>
  projectId: string
  schemaName: string
  contract: AuthorizationProjectionContract
  metadata: Record<string, unknown>
  sourceName?: string
}): Promise<{
  snapshot: AuthorizationProjectionDependencySnapshot
  projectDbUser: string
}> {
  assertIdentifier(input.schemaName, 'Project schema name')
  const projectResult = await input.client.query<{ db_user: string | null }>(
    `SELECT db_user FROM druvia_projects
     WHERE project_id = $1 AND schema_name = $2`,
    [input.projectId, input.schemaName]
  )
  const projectDbUser = projectResult.rows[0]?.db_user
  if (!projectDbUser) fail('Project database user is not configured')

  const relationResult = await input.client.query<{
    relation_kind: string
    owner: string
    security_barrier: boolean
    security_invoker: boolean
    relation_options: string[] | null
    definition: string
    public_privileges: string[] | null
    public_column_privileges: string[] | null
  }>(
    `SELECT relation.relkind AS relation_kind,
            pg_get_userbyid(relation.relowner) AS owner,
            COALESCE('security_barrier=true' = ANY(relation.reloptions), FALSE) AS security_barrier,
            COALESCE('security_invoker=true' = ANY(relation.reloptions), FALSE) AS security_invoker,
            COALESCE(relation.reloptions, ARRAY[]::text[]) AS relation_options,
            pg_get_viewdef(relation.oid, TRUE) AS definition,
            COALESCE((
              SELECT array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type)
              FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
              WHERE acl.grantee = 0
            ), ARRAY[]::text[]) AS public_privileges,
            COALESCE((
              SELECT array_agg(
                DISTINCT attribute.attname || ':' || acl.privilege_type
                ORDER BY attribute.attname || ':' || acl.privilege_type
              )
              FROM pg_attribute attribute
              CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
              WHERE attribute.attrelid = relation.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
                AND acl.grantee = 0
            ), ARRAY[]::text[]) AS public_column_privileges
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = $2`,
    [input.schemaName, input.contract.view.name]
  )
  const relation = relationResult.rows[0]
  if (!relation) fail('Projection view does not exist')

  const dependencyResult = await input.client.query<{
    schema_name: string
    relation_name: string
    relation_kind: string
    owner: string
    relation_options: string[] | null
    public_privileges: string[] | null
    public_column_privileges: string[] | null
    definition: string | null
    columns: ProjectionCatalogColumn[] | null
  }>(
    `WITH RECURSIVE relation_edges(parent_oid, child_oid) AS (
       SELECT rewrite.ev_class, dependency.refobjid
       FROM pg_rewrite rewrite
       JOIN pg_depend dependency
         ON dependency.classid = 'pg_rewrite'::regclass
        AND dependency.objid = rewrite.oid
        AND dependency.refclassid = 'pg_class'::regclass
       WHERE dependency.refobjid <> rewrite.ev_class
       UNION
       SELECT inheritance.inhparent, inheritance.inhrelid
       FROM pg_inherits inheritance
     ), dependency_tree(root_oid, relation_oid) AS (
       SELECT relation.oid, relation.oid
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = $2
       UNION
       SELECT tree.root_oid, edge.child_oid
       FROM dependency_tree tree
       JOIN relation_edges edge ON edge.parent_oid = tree.relation_oid
     )
     SELECT DISTINCT namespace.nspname AS schema_name,
            relation.relname AS relation_name,
            relation.relkind AS relation_kind,
            pg_get_userbyid(relation.relowner) AS owner,
            COALESCE(relation.reloptions, ARRAY[]::text[]) AS relation_options,
            CASE WHEN relation.relkind IN ('v', 'm') THEN COALESCE((
              SELECT array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type)
              FROM aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
              WHERE acl.grantee = 0
            ), ARRAY[]::text[]) ELSE ARRAY[]::text[] END AS public_privileges,
            CASE WHEN relation.relkind IN ('v', 'm') THEN COALESCE((
              SELECT array_agg(
                DISTINCT attribute.attname || ':' || acl.privilege_type
                ORDER BY attribute.attname || ':' || acl.privilege_type
              )
              FROM pg_attribute attribute
              CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
              WHERE attribute.attrelid = relation.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
                AND acl.grantee = 0
            ), ARRAY[]::text[]) ELSE ARRAY[]::text[] END AS public_column_privileges,
            CASE WHEN relation.relkind IN ('v', 'm')
              THEN pg_get_viewdef(relation.oid, TRUE)
              ELSE NULL
            END AS definition,
            CASE WHEN relation.relkind IN ('v', 'm') THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'name', attribute.attname,
                'type', format_type(attribute.atttypid, attribute.atttypmod),
                'nullable', NOT attribute.attnotnull
              ) ORDER BY attribute.attnum)
              FROM pg_attribute attribute
              WHERE attribute.attrelid = relation.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            ), '[]'::jsonb) ELSE NULL END AS columns
     FROM dependency_tree tree
     JOIN pg_class relation ON relation.oid = tree.relation_oid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE tree.relation_oid <> tree.root_oid
       AND namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
     ORDER BY schema_name, relation_name, relation_kind`,
    [input.schemaName, input.contract.view.name]
  )
  const functionDependencyResult = await input.client.query<{
    schema_name: string
    identity: string
  }>(
    `WITH RECURSIVE relation_edges(parent_oid, child_oid) AS (
       SELECT rewrite.ev_class, dependency.refobjid
       FROM pg_rewrite rewrite
       JOIN pg_depend dependency
         ON dependency.classid = 'pg_rewrite'::regclass
        AND dependency.objid = rewrite.oid
        AND dependency.refclassid = 'pg_class'::regclass
       WHERE dependency.refobjid <> rewrite.ev_class
       UNION
       SELECT inheritance.inhparent, inheritance.inhrelid
       FROM pg_inherits inheritance
     ), relation_tree(relation_oid) AS (
       SELECT relation.oid
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = $2
       UNION
       SELECT edge.child_oid
       FROM relation_tree tree
       JOIN relation_edges edge ON edge.parent_oid = tree.relation_oid
     ), function_dependencies(routine_oid) AS (
       SELECT dependency.refobjid
       FROM relation_tree tree
       JOIN pg_rewrite rewrite ON rewrite.ev_class = tree.relation_oid
       JOIN pg_depend dependency
         ON dependency.classid = 'pg_rewrite'::regclass
        AND dependency.objid = rewrite.oid
        AND dependency.refclassid = 'pg_proc'::regclass
       UNION
       SELECT operator.oprcode
       FROM relation_tree tree
       JOIN pg_rewrite rewrite ON rewrite.ev_class = tree.relation_oid
       JOIN pg_depend dependency
         ON dependency.classid = 'pg_rewrite'::regclass
        AND dependency.objid = rewrite.oid
        AND dependency.refclassid = 'pg_operator'::regclass
       JOIN pg_operator operator ON operator.oid = dependency.refobjid
     )
     SELECT DISTINCT namespace.nspname AS schema_name,
            routine.oid::regprocedure::text AS identity
     FROM function_dependencies dependency
     JOIN pg_proc routine ON routine.oid = dependency.routine_oid
     JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
     ORDER BY schema_name, identity`,
    [input.schemaName, input.contract.view.name]
  )

  const tableNames = [...new Set([
    input.contract.view.name,
    ...input.contract.relationships.map((item) => item.table),
  ])]
  const columnsResult = await input.client.query<{
    table_name: string
    column_name: string
    data_type: string
    udt_name: string
    is_nullable: 'YES' | 'NO'
  }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name, ordinal_position`,
    [input.schemaName, tableNames]
  )
  const columnsFor = (table: string): ProjectionCatalogColumn[] => columnsResult.rows
    .filter((column) => column.table_name === table)
    .map((column) => ({
      name: column.column_name,
      type: normalizeCatalogType(column.data_type, column.udt_name),
      nullable: column.is_nullable === 'YES',
    }))
  const duplicateResult = await input.client.query<{ duplicated: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.contract.view.name)}
       GROUP BY ${input.contract.view.key.map(quoteIdentifier).join(', ')}
       HAVING COUNT(*) > 1
     ) AS duplicated`
  )
  const metadata = inspectProjectionMetadata(
    input.metadata,
    input.sourceName ?? 'default',
    input.schemaName,
    input.contract
  )
  return {
    projectDbUser,
    snapshot: buildAuthorizationProjectionDependencySnapshot({
      schemaName: input.schemaName,
      projectDbUser,
      contract: input.contract,
      catalog: {
        relationKind: relation.relation_kind,
        owner: relation.owner,
        securityBarrier: relation.security_barrier,
        securityInvoker: relation.security_invoker,
        relationOptions: [...(relation.relation_options ?? [])].sort(),
        publicPrivileges: relation.public_privileges ?? [],
        publicColumnPrivileges: relation.public_column_privileges ?? [],
        definition: relation.definition,
        columns: columnsFor(input.contract.view.name),
        projectionKeyUnique: duplicateResult.rows[0]?.duplicated === false,
        functionDependencies: functionDependencyResult.rows.map((dependency) => ({
          schemaName: dependency.schema_name,
          identity: dependency.identity,
        })),
        relationDependencies: dependencyResult.rows.map((dependency) => ({
          schemaName: dependency.schema_name,
          relationName: dependency.relation_name,
          relationKind: dependency.relation_kind,
          view: ['v', 'm'].includes(dependency.relation_kind) ? {
            owner: dependency.owner,
            relationOptions: [...(dependency.relation_options ?? [])].sort(),
            publicPrivileges: dependency.public_privileges ?? [],
            publicColumnPrivileges: dependency.public_column_privileges ?? [],
            definitionDigest: stableDigest(normalizeViewDefinition(dependency.definition ?? '')),
            columns: dependency.columns ?? [],
          } : null,
        })),
        sourceTables: input.contract.relationships.map((item) => ({
          table: item.table,
          columns: columnsFor(item.table),
        })),
      },
      metadata,
    }),
  }
}

export function buildAuthorizationProjectionMetadata(input: {
  metadata: Record<string, unknown>
  sourceName: string
  schemaName: string
  contract: AuthorizationProjectionContract
  authenticatedRole: string
  tableSelectPermissions: Array<{ table: string; permission: Record<string, unknown> }>
}): Record<string, unknown> {
  const metadata = structuredClone(input.metadata) as {
    sources?: Array<{
      name?: string
      tables?: Array<{
        table: { schema: string; name: string }
        select_permissions?: Array<{ role: string; permission: Record<string, unknown> }>
        object_relationships?: Array<{ name: string; using: Record<string, unknown> }>
        [key: string]: unknown
      }>
      [key: string]: unknown
    }>
    [key: string]: unknown
  }
  const source = metadata.sources?.find((item) => item.name === input.sourceName)
  if (!source?.tables) fail('Default Hasura metadata source is unavailable')
  let view = source.tables.find((item) => (
    item.table.schema === input.schemaName && item.table.name === input.contract.view.name
  ))
  if (!view) {
    view = { table: { schema: input.schemaName, name: input.contract.view.name } }
    source.tables.push(view)
  }

  const targets = new Map(input.tableSelectPermissions.map((item) => [item.table, item.permission]))
  if (targets.size !== input.contract.relationships.length) {
    fail('Projection select permissions do not match the relationship contract')
  }
  for (const relationship of input.contract.relationships) {
    const table = source.tables.find((item) => (
      item.table.schema === input.schemaName && item.table.name === relationship.table
    ))
    const permission = targets.get(relationship.table)
    if (!table || !permission) fail('Projection source table metadata is unavailable')
    const existingRelationship = (table.object_relationships ?? [])
      .find((item) => item.name === relationship.name)
    const existingArrayRelationship = Array.isArray(table.array_relationships)
      ? table.array_relationships.find((item) => (
          !!item && typeof item === 'object' && 'name' in item && item.name === relationship.name
        ))
      : undefined
    if (existingArrayRelationship) {
      fail('Existing projection relationship must be an object relationship')
    }
    if (existingRelationship && !matchesProjectionRelationship(
      existingRelationship, input.schemaName, input.contract.view.name, relationship.mapping
    )) {
      fail('Existing projection relationship does not match the contract')
    }
    const preservedSelect = (table.select_permissions ?? [])
      .filter((item) => item.role !== input.authenticatedRole)
    table.select_permissions = [
      ...preservedSelect,
      { role: input.authenticatedRole, permission },
    ]

    const preservedRelationships = (table.object_relationships ?? [])
      .filter((item) => item.name !== relationship.name)
    table.object_relationships = [
      ...preservedRelationships,
      {
        name: relationship.name,
        using: projectionRelationshipUsing(
          input.schemaName, input.contract.view.name, relationship.mapping
        ),
      },
    ]
  }
  return metadata
}

export function parseAuthorizationProjectionContract(
  value: unknown
): AuthorizationProjectionContract {
  assertRecord(value, 'Projection contract must be an object')
  assertExactKeys(value, ['contractVersion', 'policyVersion', 'view', 'relationships'])
  if ((value.contractVersion !== 1 && value.contractVersion !== 2) || value.policyVersion !== 2) {
    throw new AuthorizationProjectionValidationError('Unsupported projection contract version')
  }
  assertRecord(value.view, 'Projection view must be an object')
  assertExactKeys(value.view, value.contractVersion === 2
    ? ['name', 'projectionMode', 'key', 'columns', 'environmentColumn', 'clientPermissions']
    : ['name', 'projectionMode', 'key', 'columns', 'clientPermissions'])
  assertIdentifier(value.view.name, 'Projection view name')
  if (value.view.projectionMode !== 'sparse_allow_list') {
    throw new AuthorizationProjectionValidationError('Unsupported projection mode')
  }
  const key = parseIdentifierArray(value.view.key, 'Projection key')
  if (key.length === 0) throw new AuthorizationProjectionValidationError('Projection key is required')
  assertRecord(value.view.columns, 'Projection columns must be an object')
  if (Object.keys(value.view.columns).length === 0) {
    throw new AuthorizationProjectionValidationError('Projection columns are required')
  }
  const columns = Object.fromEntries(Object.entries(value.view.columns)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => {
      assertIdentifier(name, 'Projection column')
      if (typeof type !== 'string' || !COLUMN_TYPES.has(type)
        || (value.contractVersion === 1 && type === 'jsonb')) {
        throw new AuthorizationProjectionValidationError('Unsupported projection column type')
      }
      return [name, type]
    })) as AuthorizationProjectionContract['view']['columns']
  if (key.some((name) => !(name in columns))) {
    throw new AuthorizationProjectionValidationError('Projection key references an unknown column')
  }
  if (value.contractVersion === 2) {
    assertIdentifier(value.view.environmentColumn, 'Projection environment column')
    if (columns[value.view.environmentColumn] !== 'jsonb' || key.includes(value.view.environmentColumn)) {
      throw new AuthorizationProjectionValidationError('Projection environment column must be non-key JSONB')
    }
  }
  assertRecord(value.view.clientPermissions, 'Projection client permissions must be an object')
  assertExactKeys(value.view.clientPermissions, ['select', 'insert', 'update', 'delete'])
  if (Object.values(value.view.clientPermissions).some((allowed) => allowed !== false)) {
    throw new AuthorizationProjectionValidationError('Projection view client access must stay closed')
  }
  if (!Array.isArray(value.relationships) || value.relationships.length === 0) {
    throw new AuthorizationProjectionValidationError('Projection relationships are required')
  }
  const seen = new Set<string>()
  const relationships = value.relationships.map((item) => {
    assertRecord(item, 'Projection relationship must be an object')
    assertExactKeys(item, [
      'table', 'name', 'type', 'mapping', 'ownerColumn', 'actorColumn', 'allowColumn',
    ])
    const table = item.table
    const name = item.name
    const ownerColumn = item.ownerColumn
    const actorColumn = item.actorColumn
    const allowColumn = item.allowColumn
    assertIdentifier(table, 'Projection relationship table')
    assertIdentifier(name, 'Projection relationship name')
    assertIdentifier(ownerColumn, 'Projection relationship ownerColumn')
    assertIdentifier(actorColumn, 'Projection relationship actorColumn')
    assertIdentifier(allowColumn, 'Projection relationship allowColumn')
    if (item.type !== 'object') {
      throw new AuthorizationProjectionValidationError('Only object relationships are supported')
    }
    assertRecord(item.mapping, 'Projection relationship mapping must be an object')
    const mappingEntries = Object.entries(item.mapping).sort(([left], [right]) => left.localeCompare(right))
    if (mappingEntries.length === 0) {
      throw new AuthorizationProjectionValidationError('Projection relationship mapping is required')
    }
    const mapping = Object.fromEntries(mappingEntries.map(([source, target]) => {
      assertIdentifier(source, 'Projection source column')
      assertIdentifier(target, 'Projection target column')
      return [source, target]
    }))
    const mappedTargets = Object.values(mapping)
    if (new Set(mappedTargets).size !== mappedTargets.length
      || stableDigest([...mappedTargets].sort()) !== stableDigest([...key].sort())) {
      throw new AuthorizationProjectionValidationError(
        'Projection relationship mapping must cover the complete view key exactly once'
      )
    }
    if (!(actorColumn in columns) || !(allowColumn in columns)) {
      throw new AuthorizationProjectionValidationError('Projection relationship references an unknown view column')
    }
    if (!key.includes(actorColumn)) {
      throw new AuthorizationProjectionValidationError('Projection key must include the actor column')
    }
    if (mapping[ownerColumn] !== actorColumn) {
      throw new AuthorizationProjectionValidationError(
        'Projection owner column must map to the actor column'
      )
    }
    const identity = `${table}\u0000${name}`
    if (seen.has(identity)) {
      throw new AuthorizationProjectionValidationError('Duplicate projection relationship')
    }
    seen.add(identity)
    return {
      table,
      name,
      type: 'object' as const,
      mapping,
      ownerColumn,
      actorColumn,
      allowColumn,
    }
  }).sort((left, right) => left.table.localeCompare(right.table) || left.name.localeCompare(right.name))

  return {
    contractVersion: value.contractVersion,
    policyVersion: 2,
    view: {
      name: value.view.name,
      projectionMode: 'sparse_allow_list',
      key,
      columns,
      ...(value.contractVersion === 2 ? { environmentColumn: value.view.environmentColumn as string } : {}),
      clientPermissions: { select: false, insert: false, update: false, delete: false },
    },
    relationships,
  }
}

export function buildAuthorizationProjectionDependencySnapshot(input: {
  schemaName: string
  projectDbUser: string
  contract: AuthorizationProjectionContract
  catalog: AuthorizationProjectionCatalog
  metadata: AuthorizationProjectionMetadata
}): AuthorizationProjectionDependencySnapshot {
  const { catalog, contract } = input
  if (catalog.relationKind !== 'v') fail('Projection relation must be a regular view')
  if (catalog.owner !== input.projectDbUser) fail('Projection view owner does not match the project database user')
  if (!catalog.securityBarrier) fail('Projection view must enable security barrier')
  if (catalog.securityInvoker) fail('Projection view must not enable security invoker')
  if (catalog.publicPrivileges.length > 0) fail('Projection view grants privileges to PUBLIC')
  if (catalog.publicColumnPrivileges.length > 0) {
    fail('Projection view grants column privileges to PUBLIC')
  }
  if (!catalog.projectionKeyUnique) fail('Projection view key contains duplicate rows')
  if (catalog.functionDependencies.length > 0) {
    fail('Projection view function dependencies must remain system-only')
  }
  for (const dependency of catalog.relationDependencies) {
    if (dependency.schemaName !== input.schemaName) {
      fail('Projection view relation dependencies must remain in the project schema')
    }
    if (['v', 'm'].includes(dependency.relationKind)) {
      if (!dependency.view) fail('Projection helper view snapshot is unavailable')
      if (dependency.view.owner !== input.projectDbUser) {
        fail('Projection helper view owner does not match the project database user')
      }
      if (dependency.view.publicPrivileges.length > 0) {
        fail('Projection helper view grants privileges to PUBLIC')
      }
      if (dependency.view.publicColumnPrivileges.length > 0) {
        fail('Projection helper view grants column privileges to PUBLIC')
      }
      if (dependency.view.relationOptions.includes('security_invoker=true')) {
        fail('Projection helper view must not enable security invoker')
      }
    }
  }
  if (input.metadata.viewScopedPermissions.length > 0) {
    fail('Projection view must not have client permissions')
  }

  const expectedColumns = Object.entries(contract.view.columns).sort(([a], [b]) => a.localeCompare(b))
  const actualColumns = [...catalog.columns].sort((a, b) => a.name.localeCompare(b.name))
  if (actualColumns.length !== expectedColumns.length || expectedColumns.some(([name, type], index) => (
    actualColumns[index]?.name !== name || normalizeType(actualColumns[index]?.type) !== type
  ))) fail('Projection view columns do not match the contract')

  for (const relationship of contract.relationships) {
    if (!input.metadata.trackedTables.includes(relationship.table)) {
      fail('Projection source table is not tracked')
    }
    const actor = actualColumns.find((column) => column.name === relationship.actorColumn)
    const allow = actualColumns.find((column) => column.name === relationship.allowColumn)
    const environment = contract.view.environmentColumn
      ? actualColumns.find((column) => column.name === contract.view.environmentColumn)
      : null
    if (normalizeType(actor?.type) !== 'uuid') fail('Projection actor column must be UUID')
    if (normalizeType(allow?.type) !== 'boolean') {
      fail('Projection allow column must be boolean')
    }
    if (contract.view.environmentColumn && normalizeType(environment?.type) !== 'jsonb') {
      fail('Projection environment column must be JSONB')
    }
    const source = catalog.sourceTables.find((table) => table.table === relationship.table)
    if (!source) fail('Projection source table is unavailable')
    const owner = source.columns.find((column) => column.name === relationship.ownerColumn)
    if (!owner || normalizeType(owner.type) !== 'uuid') fail('Projection owner column must be UUID')
    for (const [sourceName, targetName] of Object.entries(relationship.mapping)) {
      const sourceColumn = source.columns.find((column) => column.name === sourceName)
      const targetColumn = actualColumns.find((column) => column.name === targetName)
      if (!sourceColumn || !targetColumn || normalizeType(sourceColumn.type) !== normalizeType(targetColumn.type)) {
        fail('Projection relationship column mapping is invalid')
      }
    }
    const matches = input.metadata.relationships.filter(
      (item) => item.table === relationship.table && item.name === relationship.name
    )
    if (matches.length !== 1) fail('Projection relationship must exist exactly once')
    const existing = matches[0]
    if (existing.type !== 'object') fail('Projection relationship must be an object relationship')
    const expectedUsing = projectionRelationshipUsing(
      input.schemaName, contract.view.name, relationship.mapping
    )
    if (
      existing.targetSchema !== input.schemaName
      || existing.targetTable !== contract.view.name
      || stableDigest(existing.mapping) !== stableDigest(relationship.mapping)
      || stableDigest(existing.using) !== stableDigest(expectedUsing)
    ) fail('Existing projection relationship does not match the contract')
  }

  const withoutDigest = {
    schemaName: input.schemaName,
    contract,
    view: {
      name: contract.view.name,
      owner: catalog.owner,
      securityBarrier: true as const,
      securityInvoker: false as const,
      relationOptions: [...catalog.relationOptions].sort(),
      publicPrivileges: [...catalog.publicPrivileges].sort(),
      publicColumnPrivileges: [...catalog.publicColumnPrivileges].sort(),
      definitionDigest: stableDigest(normalizeViewDefinition(catalog.definition)),
      columns: actualColumns,
      key: contract.view.key,
      tracked: input.metadata.viewTracked,
      relationDependencies: [...catalog.relationDependencies].sort((left, right) => (
        left.schemaName.localeCompare(right.schemaName)
        || left.relationName.localeCompare(right.relationName)
        || left.relationKind.localeCompare(right.relationKind)
      )),
    },
    relationships: contract.relationships.map((item) => ({
      table: item.table,
      name: item.name,
      type: 'object' as const,
      using: input.metadata.relationships.find((relationship) => (
        relationship.table === item.table && relationship.name === item.name
      ))!.using,
      mapping: input.metadata.relationships.find((relationship) => (
        relationship.table === item.table && relationship.name === item.name
      ))!.mapping,
      ownerColumn: item.ownerColumn,
      actorColumn: item.actorColumn,
      allowColumn: item.allowColumn,
    })),
  }
  return { ...withoutDigest, digest: stableDigest(withoutDigest) }
}

export function authorizationProjectionMetadataDigest(
  metadata: Record<string, unknown>,
  sourceName: string,
  schemaName: string,
  contract: AuthorizationProjectionContract
): string {
  const sources = Array.isArray(metadata.sources) ? metadata.sources : []
  const source = sources.find((item) => isRecord(item) && item.name === sourceName)
  if (!isRecord(source) || !Array.isArray(source.tables)) {
    fail('Default Hasura metadata source is unavailable')
  }
  const names = new Set([
    contract.view.name,
    ...contract.relationships.map((item) => item.table),
  ])
  const tables = source.tables
    .filter(isMetadataTable)
    .filter((table) => table.table.schema === schemaName && names.has(table.table.name))
    .map((table) => canonicalizeMetadataTable(table))
    .sort((left, right) => left.table.name.localeCompare(right.table.name))
  return stableDigest({ sourceName, schemaName, tables })
}

function canonicalizeMetadataTable(
  table: Record<string, unknown> & { table: { schema: string; name: string } }
): Record<string, unknown> & { table: { schema: string; name: string } } {
  const result = structuredClone(table)
  for (const key of [
    'select_permissions', 'insert_permissions', 'update_permissions', 'delete_permissions',
  ]) {
    if (Array.isArray(result[key])) {
      result[key] = [...result[key] as unknown[]]
        .map((permission) => key === 'select_permissions'
          ? normalizeSelectMetadataPermission(permission)
          : permission)
        .sort((left, right) => (
          stringProperty(left, 'role').localeCompare(stringProperty(right, 'role'))
        ))
    }
  }
  for (const key of ['object_relationships', 'array_relationships']) {
    if (Array.isArray(result[key])) {
      result[key] = [...result[key] as unknown[]].sort((left, right) => (
        stringProperty(left, 'name').localeCompare(stringProperty(right, 'name'))
      ))
    }
  }
  return result
}

function normalizeSelectMetadataPermission(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.permission)) return value
  const permission = { ...value.permission }
  if (permission.allow_aggregations === false) delete permission.allow_aggregations
  return { ...value, permission }
}

function stringProperty(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : ''
}

function inspectProjectionMetadata(
  value: Record<string, unknown>,
  sourceName: string,
  schemaName: string,
  contract: AuthorizationProjectionContract
): AuthorizationProjectionMetadata {
  const sources = Array.isArray(value.sources) ? value.sources : []
  const source = sources.find((item) => isRecord(item) && item.name === sourceName)
  if (!isRecord(source) || !Array.isArray(source.tables)) fail('Default Hasura metadata source is unavailable')
  const tables = source.tables.filter(isMetadataTable)
  const view = tables.find((item) => (
    item.table.schema === schemaName && item.table.name === contract.view.name
  ))
  const permissionOperations = ['select', 'insert', 'update', 'delete'] as const
  const viewScopedPermissions = view
    ? permissionOperations.flatMap((operation) => {
        const entries = view[`${operation}_permissions`]
        return Array.isArray(entries) ? entries.map((entry) => `${operation}:${String(
          isRecord(entry) ? entry.role : 'unknown'
        )}`) : []
      })
    : []
  const relationships = tables.flatMap((table) => {
    if (table.table.schema !== schemaName) return []
    return (['object', 'array'] as const).flatMap((type) => {
      const entries = table[`${type}_relationships`]
      if (!Array.isArray(entries)) return []
      return entries.flatMap((relationship) => {
        if (!isRecord(relationship) || typeof relationship.name !== 'string'
          || !isRecord(relationship.using) || !isRecord(relationship.using.manual_configuration)) return []
        const manual = relationship.using.manual_configuration
        if (!isRecord(manual.remote_table) || !isRecord(manual.column_mapping)) return []
        return [{
          table: table.table.name,
          name: relationship.name,
          type,
          using: structuredClone(relationship.using),
          targetSchema: String(manual.remote_table.schema ?? ''),
          targetTable: String(manual.remote_table.name ?? ''),
          mapping: Object.fromEntries(Object.entries(manual.column_mapping)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        }]
      })
    })
  })
  return {
    viewTracked: !!view,
    viewScopedPermissions,
    trackedTables: tables.filter((table) => table.table.schema === schemaName)
      .map((table) => table.table.name),
    relationships,
  }
}

function matchesProjectionRelationship(
  relationship: { name: string; using: Record<string, unknown> },
  schemaName: string,
  viewName: string,
  mapping: Record<string, string>
): boolean {
  const manual = relationship.using.manual_configuration
  if (!isRecord(manual) || !isRecord(manual.remote_table) || !isRecord(manual.column_mapping)) {
    return false
  }
  return stableDigest(relationship.using) === stableDigest(
    projectionRelationshipUsing(schemaName, viewName, mapping)
  )
}

function projectionRelationshipUsing(
  schemaName: string,
  viewName: string,
  mapping: Record<string, string>
): Record<string, unknown> {
  return {
    manual_configuration: {
      remote_table: { schema: schemaName, name: viewName },
      column_mapping: mapping,
      insertion_order: null,
    },
  }
}

function isMetadataTable(value: unknown): value is Record<string, unknown> & {
  table: { schema: string; name: string }
} {
  return isRecord(value) && isRecord(value.table)
    && typeof value.table.schema === 'string' && typeof value.table.name === 'string'
}

function normalizeCatalogType(dataType: string, udtName: string): string {
  if (dataType === 'USER-DEFINED') return udtName
  if (dataType === 'boolean') return 'boolean'
  if (dataType === 'uuid') return 'uuid'
  if (dataType === 'text' || dataType === 'character varying') return 'text'
  return dataType
}

function quoteIdentifier(value: string): string {
  assertIdentifier(value, 'SQL identifier')
  return `"${value}"`
}

function normalizeType(type: string | undefined): string | undefined {
  return type === 'bool' ? 'boolean' : type
}

function normalizeViewDefinition(definition: string): string {
  return definition.trim()
}

function parseIdentifierArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AuthorizationProjectionValidationError(`${label} must be an array`)
  }
  for (const item of value) assertIdentifier(item, label)
  if (new Set(value).size !== value.length) {
    throw new AuthorizationProjectionValidationError(`${label} contains duplicates`)
  }
  return [...value]
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new AuthorizationProjectionValidationError(`${label} is invalid`)
  }
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorizationProjectionValidationError(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AuthorizationProjectionValidationError('Projection contract contains unknown or missing fields')
  }
}

function fail(message: string): never {
  throw new AuthorizationProjectionValidationError(message)
}
