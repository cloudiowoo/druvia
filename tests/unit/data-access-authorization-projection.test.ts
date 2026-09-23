import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationProjectionMetadata,
  buildAuthorizationProjectionDependencySnapshot,
  authorizationProjectionMetadataDigest,
  parseAuthorizationProjectionContract,
} from '../../apps/api/src/modules/data-access/data-access-authorization-projection.js'

const contract = {
  contractVersion: 1,
  policyVersion: 2,
  view: {
    name: 'session_access_projection',
    projectionMode: 'sparse_allow_list',
    key: ['session_id', 'user_id'],
    columns: {
      session_id: 'uuid',
      user_id: 'uuid',
      can_read_basic: 'boolean',
    },
    clientPermissions: { select: false, insert: false, update: false, delete: false },
  },
  relationships: [{
    table: 'football_session',
    name: 'session_access_projection',
    type: 'object',
    mapping: { id: 'session_id', user_id: 'user_id' },
    ownerColumn: 'user_id',
    actorColumn: 'user_id',
    allowColumn: 'can_read_basic',
  }],
}

const environmentContract = {
  ...contract,
  contractVersion: 2,
  view: {
    ...contract.view,
    environmentColumn: 'allowed_environments',
    columns: { ...contract.view.columns, allowed_environments: 'jsonb' },
  },
}

const managedRelationship = {
  table: 'football_session',
  name: 'session_access_projection',
  type: 'object' as const,
  using: {
    manual_configuration: {
      remote_table: {
        schema: 'dru_default_pitchetch', name: 'session_access_projection',
      },
      column_mapping: { id: 'session_id', user_id: 'user_id' },
      insertion_order: null,
    },
  },
  targetSchema: 'dru_default_pitchetch',
  targetTable: 'session_access_projection',
  mapping: { id: 'session_id', user_id: 'user_id' },
}

describe('data access authorization projection contract', () => {
  it('parses and canonicalizes a strict project-local contract', () => {
    expect(parseAuthorizationProjectionContract(contract)).toEqual(contract)
  })

  it('accepts an environment-scoped contract without changing the complete relationship key', () => {
    expect(parseAuthorizationProjectionContract(environmentContract)).toEqual(environmentContract)
  })

  it.each([
    { ...environmentContract, view: { ...environmentContract.view, environmentColumn: 'missing' } },
    { ...environmentContract, view: { ...environmentContract.view, columns: { ...contract.view.columns, allowed_environments: 'text' } } },
    { ...environmentContract, view: { ...environmentContract.view, environmentColumn: 'user_id' } },
    { ...contract, view: { ...environmentContract.view } },
    { ...environmentContract, view: { ...contract.view } },
    { ...contract, view: { ...contract.view, columns: { ...contract.view.columns, extra: 'jsonb' } } },
  ])('rejects missing, mistyped, or version-mismatched environment columns', (value) => {
    expect(() => parseAuthorizationProjectionContract(value)).toThrow()
  })

  it.each([
    { ...contract, schema: 'other' },
    { ...contract, policyVersion: 1 },
    { ...contract, view: { ...contract.view, arbitrarySql: 'select true' } },
    { ...contract, view: { ...contract.view, key: [] } },
    {
      ...contract,
      relationships: [{ ...contract.relationships[0], type: 'array' }],
    },
    {
      ...contract,
      relationships: [{ ...contract.relationships[0], mapping: { 'bad.name': 'session_id' } }],
    },
    {
      ...contract,
      relationships: [{
        ...contract.relationships[0],
        mapping: { id: 'session_id' },
      }],
    },
    {
      ...contract,
      relationships: [{
        ...contract.relationships[0],
        mapping: { id: 'session_id', user_id: 'session_id' },
      }],
    },
    {
      ...contract,
      relationships: [{
        ...contract.relationships[0],
        mapping: { id: 'user_id', user_id: 'session_id' },
      }],
    },
  ])('rejects unsupported or unknown contract structure', (value) => {
    expect(() => parseAuthorizationProjectionContract(value)).toThrow()
  })

  it('builds a stable dependency snapshot with per-table mappings', () => {
    const relationDependencies = [{
      schemaName: 'dru_default_pitchetch',
      relationName: 'commercial_entitlement',
      relationKind: 'r',
      view: null,
    }]
    const snapshot = buildAuthorizationProjectionDependencySnapshot({
      schemaName: 'dru_default_pitchetch',
      projectDbUser: 'dru_default_pitchetch_user',
      contract: parseAuthorizationProjectionContract(contract),
      catalog: {
        relationKind: 'v',
        owner: 'dru_default_pitchetch_user',
        securityBarrier: true,
        securityInvoker: false,
        relationOptions: ['security_barrier=true'],
        publicPrivileges: [],
        publicColumnPrivileges: [],
        definition: ' SELECT session_id, user_id, true AS can_read_basic FROM source;',
        columns: [
          { name: 'session_id', type: 'uuid', nullable: false },
          { name: 'user_id', type: 'uuid', nullable: false },
          { name: 'can_read_basic', type: 'boolean', nullable: false },
        ],
        projectionKeyUnique: true,
        functionDependencies: [],
        relationDependencies,
        sourceTables: [{
          table: 'football_session',
          columns: [
            { name: 'id', type: 'uuid', nullable: false },
            { name: 'user_id', type: 'uuid', nullable: false },
          ],
        }],
      },
      metadata: {
        viewTracked: false,
        viewScopedPermissions: [],
        trackedTables: ['football_session'],
        relationships: [managedRelationship],
      },
    })

    expect(snapshot.schemaName).toBe('dru_default_pitchetch')
    expect(snapshot.view.relationDependencies).toEqual(relationDependencies)
    expect(snapshot.relationships[0].mapping).toEqual({ id: 'session_id', user_id: 'user_id' })
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('binds an environment-scoped contract to the JSONB view column and its definition', () => {
    const parsed = parseAuthorizationProjectionContract(environmentContract)
    const base = {
      schemaName: 'dru_default_pitchetch', projectDbUser: 'dru_default_pitchetch_user',
      contract: parsed,
      catalog: {
        relationKind: 'v', owner: 'dru_default_pitchetch_user', securityBarrier: true,
        securityInvoker: false, relationOptions: ['security_barrier=true'],
        publicPrivileges: [], publicColumnPrivileges: [], definition: 'select allowed_environments from entitlement',
        columns: [
          { name: 'session_id', type: 'uuid', nullable: false },
          { name: 'user_id', type: 'uuid', nullable: false },
          { name: 'can_read_basic', type: 'boolean', nullable: false },
          { name: 'allowed_environments', type: 'jsonb', nullable: true },
        ],
        projectionKeyUnique: true, functionDependencies: [],
        relationDependencies: [{ schemaName: 'dru_default_pitchetch', relationName: 'entitlement', relationKind: 'r', view: null }],
        sourceTables: [{ table: 'football_session', columns: [
          { name: 'id', type: 'uuid', nullable: false }, { name: 'user_id', type: 'uuid', nullable: false },
        ] }],
      },
      metadata: { viewTracked: true, viewScopedPermissions: [],
        trackedTables: ['football_session'], relationships: [managedRelationship] },
    }
    const snapshot = buildAuthorizationProjectionDependencySnapshot(base)
    expect(snapshot.view.columns).toContainEqual({ name: 'allowed_environments', type: 'jsonb', nullable: true })
    expect(buildAuthorizationProjectionDependencySnapshot({ ...base, catalog: {
      ...base.catalog, definition: 'select filtered_environments from entitlement',
    } }).digest).not.toBe(snapshot.digest)
    expect(() => buildAuthorizationProjectionDependencySnapshot({ ...base, catalog: {
      ...base.catalog, columns: base.catalog.columns.map((column) => column.name === 'allowed_environments'
        ? { ...column, type: 'text' } : column),
    } })).toThrow()
  })

  it('fails closed when the view or relationship dependency is unsafe', () => {
    const parsed = parseAuthorizationProjectionContract(contract)
    const base = {
      schemaName: 'dru_default_pitchetch',
      projectDbUser: 'dru_default_pitchetch_user',
      contract: parsed,
      catalog: {
        relationKind: 'v' as const,
        owner: 'dru_default_pitchetch_user',
        securityBarrier: true,
        securityInvoker: false,
        relationOptions: ['security_barrier=true'],
        publicPrivileges: [],
        publicColumnPrivileges: [],
        definition: 'select 1',
        columns: [
          { name: 'session_id', type: 'uuid', nullable: false },
          { name: 'user_id', type: 'uuid', nullable: false },
          { name: 'can_read_basic', type: 'boolean', nullable: false },
        ],
        projectionKeyUnique: true,
        functionDependencies: [],
        relationDependencies: [{
          schemaName: 'dru_default_pitchetch', relationName: 'commercial_entitlement', relationKind: 'r', view: null,
        }],
        sourceTables: [{
          table: 'football_session',
          columns: [
            { name: 'id', type: 'uuid', nullable: false },
            { name: 'user_id', type: 'uuid', nullable: false },
          ],
        }],
      },
      metadata: {
        viewTracked: true,
        viewScopedPermissions: [],
        trackedTables: ['football_session'],
        relationships: [managedRelationship],
      },
    }

    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: { ...base.catalog, securityBarrier: false },
    })).toThrow(/security barrier/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: { ...base.catalog, publicColumnPrivileges: ['allowed:SELECT'] },
    })).toThrow(/column privileges/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: {
        ...base.catalog,
        securityInvoker: true,
        relationOptions: ['security_barrier=true', 'security_invoker=true'],
      },
    })).toThrow(/security invoker/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      metadata: { ...base.metadata, viewScopedPermissions: ['select'] },
    })).toThrow(/client permission/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      metadata: {
        ...base.metadata,
        relationships: [{
          table: 'football_session', name: 'session_access_projection',
          targetSchema: 'other', targetTable: 'session_access_projection',
          mapping: { id: 'session_id', user_id: 'user_id' },
        }],
      },
    })).toThrow(/relationship/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: {
        ...base.catalog,
        relationDependencies: [{
          schemaName: 'dru_default_pitchetch_dev', relationName: 'commercial_entitlement', relationKind: 'r', view: null,
        }],
      },
    })).toThrow(/schema/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: {
        ...base.catalog,
        functionDependencies: [{ schemaName: 'dru_default_pitchetch', identity: 'is_allowed(uuid)' }],
      },
    })).toThrow(/function/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      catalog: {
        ...base.catalog,
        relationDependencies: [{
          schemaName: 'dru_default_pitchetch',
          relationName: 'projection_helper',
          relationKind: 'v',
          view: {
            owner: 'dru_default_pitchetch_user',
            relationOptions: [],
            publicPrivileges: [],
            publicColumnPrivileges: ['allowed:SELECT'],
            definitionDigest: 'a'.repeat(64),
            columns: [],
          },
        }],
      },
    })).toThrow(/column privileges/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      metadata: { ...base.metadata, relationships: [] },
    })).toThrow(/relationship/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      metadata: {
        ...base.metadata,
        relationships: [{ ...managedRelationship, type: 'array' as const }],
      },
    })).toThrow(/object relationship/i)
    expect(() => buildAuthorizationProjectionDependencySnapshot({
      ...base,
      metadata: {
        ...base.metadata,
        relationships: [{
          ...managedRelationship,
          using: {
            manual_configuration: {
              ...managedRelationship.using.manual_configuration,
              insertion_order: 'before_parent',
            },
          },
        }],
      },
    })).toThrow(/relationship/i)
  })

  it('preserves semantic whitespace inside view definition string literals', () => {
    const parsed = parseAuthorizationProjectionContract(contract)
    const catalog = {
      relationKind: 'v', owner: 'dru_default_pitchetch_user',
      securityBarrier: true, securityInvoker: false,
      relationOptions: ['security_barrier=true'], publicPrivileges: [], publicColumnPrivileges: [],
      definition: "SELECT 'basic  trial'::text AS label, session_id, user_id, true AS can_read_basic FROM source",
      columns: [
        { name: 'session_id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
        { name: 'can_read_basic', type: 'boolean', nullable: false },
      ],
      projectionKeyUnique: true,
      functionDependencies: [],
      relationDependencies: [],
      sourceTables: [{
        table: 'football_session',
        columns: [
          { name: 'id', type: 'uuid', nullable: false },
          { name: 'user_id', type: 'uuid', nullable: false },
        ],
      }],
    }
    const input = {
      schemaName: 'dru_default_pitchetch',
      projectDbUser: 'dru_default_pitchetch_user',
      contract: parsed,
      metadata: {
        viewTracked: true, viewScopedPermissions: [],
        trackedTables: ['football_session'], relationships: [managedRelationship],
      },
    }
    const doubleSpace = buildAuthorizationProjectionDependencySnapshot({ ...input, catalog })
    const singleSpace = buildAuthorizationProjectionDependencySnapshot({
      ...input,
      catalog: { ...catalog, definition: catalog.definition.replace('basic  trial', 'basic trial') },
    })

    expect(doubleSpace.digest).not.toBe(singleSpace.digest)
  })

  it('builds one target metadata document and preserves unrelated rules', () => {
    const metadata = {
      version: 3,
      sources: [{
        name: 'default',
        kind: 'postgres',
        tables: [{
          table: { schema: 'dru_default_pitchetch', name: 'football_session' },
          select_permissions: [
            { role: 'external_role', permission: { columns: '*', filter: {} } },
            { role: 'scope_user', permission: { columns: ['id'], filter: { user_id: { _eq: 'X-Hasura-User-Id' } } } },
          ],
          insert_permissions: [{ role: 'scope_user', permission: { columns: ['id'], check: {} } }],
        }],
      }],
    }
    const target = buildAuthorizationProjectionMetadata({
      metadata,
      sourceName: 'default',
      schemaName: 'dru_default_pitchetch',
      contract: parseAuthorizationProjectionContract(contract),
      authenticatedRole: 'scope_user',
      tableSelectPermissions: [{
        table: 'football_session',
        permission: {
          columns: ['id', 'user_id'],
          filter: { _and: [] },
          allow_aggregations: false,
        },
      }],
    }) as typeof metadata

    const tables = target.sources[0].tables
    const source = tables.find((item) => item.table.name === 'football_session')!
    const view = tables.find((item) => item.table.name === 'session_access_projection')!
    expect(source.select_permissions).toEqual([
      { role: 'external_role', permission: { columns: '*', filter: {} } },
      {
        role: 'scope_user',
        permission: { columns: ['id', 'user_id'], filter: { _and: [] }, allow_aggregations: false },
      },
    ])
    expect(source.insert_permissions).toHaveLength(1)
    expect(source.object_relationships).toEqual([{
      name: 'session_access_projection',
      using: {
        manual_configuration: {
          remote_table: { schema: 'dru_default_pitchetch', name: 'session_access_projection' },
          column_mapping: { id: 'session_id', user_id: 'user_id' },
          insertion_order: null,
        },
      },
    }])
    expect(view.select_permissions).toBeUndefined()
  })

  it('rejects an existing relationship with the same name but different mapping', () => {
    const metadata = {
      version: 3,
      sources: [{
        name: 'default',
        tables: [{
          table: { schema: 'dru_default_pitchetch', name: 'football_session' },
          object_relationships: [{
            name: 'session_access_projection',
            using: {
              manual_configuration: {
                remote_table: {
                  schema: 'dru_default_pitchetch', name: 'session_access_projection',
                },
                column_mapping: { id: 'user_id', user_id: 'session_id' },
                insertion_order: null,
              },
            },
          }],
        }],
      }],
    }

    expect(() => buildAuthorizationProjectionMetadata({
      metadata,
      sourceName: 'default',
      schemaName: 'dru_default_pitchetch',
      contract: parseAuthorizationProjectionContract(contract),
      authenticatedRole: 'scope_user',
      tableSelectPermissions: [{
        table: 'football_session',
        permission: { columns: ['id'], filter: {} },
      }],
    })).toThrow(/existing projection relationship/i)
  })

  it('normalizes the omitted Hasura false aggregation default in metadata digests', () => {
    const withDefault = {
      sources: [{ name: 'default', tables: [{
        table: { schema: 'dru_default_pitchetch', name: 'football_session' },
        select_permissions: [{
          role: 'scope_user',
          permission: { columns: ['id'], filter: {}, allow_aggregations: false },
        }],
      }] }],
    }
    const withoutDefault = structuredClone(withDefault)
    delete withoutDefault.sources[0].tables[0].select_permissions[0]
      .permission.allow_aggregations
    const parsed = parseAuthorizationProjectionContract(contract)

    expect(authorizationProjectionMetadataDigest(
      withDefault, 'default', 'dru_default_pitchetch', parsed
    )).toBe(authorizationProjectionMetadataDigest(
      withoutDefault, 'default', 'dru_default_pitchetch', parsed
    ))
  })
})
