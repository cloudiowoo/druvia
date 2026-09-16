import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../../apps/api/src/config/index.js'
import { pool } from '../../apps/api/src/db/index.js'
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import {
  getTableDataAccess,
  updateTableDataAccess,
} from '../../apps/api/src/modules/data-access/data-access.service.js'
import {
  applyAuthorizationProjection,
  getActiveAuthorizationProjection,
  previewAuthorizationProjection,
  recoverAuthorizationProjection,
} from '../../apps/api/src/modules/data-access/data-access-authorization-projection.service.js'
import {
  applyPolicyReconcile,
  previewPolicyReconcile,
} from '../../apps/api/src/modules/data-access/data-access-policy-operation.service.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import {
  hasuraMetadataRequest,
  hasuraMetadataRequestWithOptions,
} from '../../apps/api/src/modules/realtime/realtime.service.js'

const runIntegration = process.env.DRUVIA_RUN_DATA_ACCESS_PROJECTION_INTEGRATION === '1'

describe.skipIf(!runIntegration)('authorization projection against PostgreSQL and Hasura 2.48', () => {
  let platformUid = 0
  let platformUserId = ''
  let tenantId = ''
  let projectId = ''
  let projectAlias = ''
  let schemaName = ''
  let foreignSchemaName = ''
  let originalAdminSecret = ''
  const ownerA = randomUUID()
  const ownerB = randomUUID()
  const allowedA = randomUUID()
  const deniedA = randomUUID()
  const allowedB = randomUUID()

  beforeAll(async () => {
    const adminSecret = process.env.DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET || ''
    if (!adminSecret) throw new Error('Projection integration requires a Hasura admin secret')
    originalAdminSecret = config.hasura.adminSecret
    config.hasura.adminSecret = adminSecret
    const migration = await pool.query<{ available: boolean }>(
      `SELECT to_regclass('public.druvia_data_access_projection_operations') IS NOT NULL AS available`
    )
    if (!migration.rows[0]?.available) throw new Error('Projection integration requires migration 027')

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    platformUserId = `projection-${suffix}`
    const user = await pool.query<{ id: number }>(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [platformUserId, `${platformUserId}@test.local`, `projection_${suffix}`]
    )
    platformUid = user.rows[0].id
    const tenant = await tenantService.createTenant({
      alias: `p${suffix}`, name: 'Projection Integration', ownerUid: platformUid,
    })
    tenantId = tenant.tenantId
    const project = await projectService.createProject({
      tenantId, alias: `p${suffix}`, name: 'Projection Integration',
    })
    projectId = project.projectId
    projectAlias = project.alias
    schemaName = project.schemaName || ''
    if (!schemaName) throw new Error('Projection integration project schema is unavailable')
    foreignSchemaName = `${schemaName}_foreign`
    await pool.query('UPDATE druvia_projects SET db_user = current_user WHERE project_id = $1', [projectId])
    await pool.query(`
      CREATE TABLE "${schemaName}".projection_orders (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        value TEXT NOT NULL,
        legacy_note TEXT
      );
      CREATE TABLE "${schemaName}".projection_grants (
        session_id UUID NOT NULL,
        user_id UUID NOT NULL,
        allowed BOOLEAN NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await pool.query(
      `INSERT INTO "${schemaName}".projection_orders (id, user_id, value)
       VALUES ($1, $2, 'allowed-a'), ($3, $2, 'denied-a'), ($4, $5, 'allowed-b')`,
      [allowedA, ownerA, deniedA, allowedB, ownerB]
    )
    await pool.query(
      `INSERT INTO "${schemaName}".projection_grants (session_id, user_id, allowed)
       VALUES ($1, $2, TRUE), ($3, $2, FALSE), ($4, $5, TRUE)`,
      [allowedA, ownerA, deniedA, allowedB, ownerB]
    )
    await updateTableDataAccess(projectId, 'projection_orders', {
      policyVersion: 1,
      operationId: `projection_baseline_${suffix}`,
      authenticated: {
        select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'user_id',
      },
      anonymous: { select: false },
      columnGrants: {
        authenticated: {
          select: ['id', 'user_id', 'value', 'legacy_note'],
          insert: ['id', 'value', 'legacy_note'],
          update: [],
        },
        anonymous: { select: [] },
      },
    }, platformUserId)
  }, 30_000)

  afterAll(async () => {
    if (foreignSchemaName) {
      await pool.query(`DROP SCHEMA IF EXISTS "${foreignSchemaName}" CASCADE`).catch(() => undefined)
    }
    if (schemaName) {
      for (const table of ['projection_orders', 'access_projection']) {
        await hasuraMetadataRequest('pg_untrack_table', {
          source: 'default', table: { schema: schemaName, name: table }, cascade: true,
        }).catch(() => undefined)
      }
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined)
    }
    if (projectId) {
      await pool.query(
        `UPDATE druvia_data_access_projection_operations
         SET status = 'failed', phase = 'completed', writer_epoch = NULL,
             write_deadline_at = NULL, completed_at = NOW(),
             error_code = 'INTEGRATION_TEST_CLEANUP', error_message = 'Integration fixture removed'
         WHERE project_id = $1 AND status IN ('applying', 'recovering', 'recovery_required')`,
        [projectId]
      ).catch(() => undefined)
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [projectId]).catch(() => undefined)
    }
    if (tenantId) await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
    if (platformUid) await pool.query('DELETE FROM druvia_users WHERE id = $1', [platformUid]).catch(() => undefined)
    config.hasura.adminSecret = originalAdminSecret
  })

  it('enforces owner plus projection and keeps the projection relation private', async () => {
    const contract = {
      contractVersion: 1 as const,
      policyVersion: 2 as const,
      view: {
        name: 'access_projection', projectionMode: 'sparse_allow_list' as const,
        key: ['session_id', 'user_id'],
        columns: { session_id: 'uuid' as const, user_id: 'uuid' as const, allowed: 'boolean' as const },
        clientPermissions: { select: false as const, insert: false as const, update: false as const, delete: false as const },
      },
      relationships: [{
        table: 'projection_orders', name: 'access_projection', type: 'object' as const,
        mapping: { id: 'session_id', user_id: 'user_id' }, ownerColumn: 'user_id',
        actorColumn: 'user_id', allowColumn: 'allowed',
      }],
    }
    await pool.query(`
      GRANT SELECT (allowed) ON "${schemaName}".access_projection TO PUBLIC;
    `)
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toThrow(/column privileges/i)
    await pool.query(`
      REVOKE SELECT (allowed) ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await pool.query(`
      CREATE FUNCTION "${schemaName}".projection_allow(value boolean)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value $$;
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, "${schemaName}".projection_allow(allowed) AS allowed
      FROM "${schemaName}".projection_grants;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toThrow(/function dependencies/i)
    await pool.query(`
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants;
      DROP FUNCTION "${schemaName}".projection_allow(boolean);
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await pool.query(`
      CREATE FUNCTION "${schemaName}".projection_operator(left_value boolean, right_value boolean)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT left_value AND right_value $$;
      CREATE OPERATOR "${schemaName}".=== (
        LEFTARG = boolean,
        RIGHTARG = boolean,
        FUNCTION = "${schemaName}".projection_operator
      );
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id,
             allowed OPERATOR("${schemaName}".===) TRUE AS allowed
      FROM "${schemaName}".projection_grants;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toThrow(/function dependencies/i)
    await pool.query(`
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants;
      DROP OPERATOR "${schemaName}".===(boolean, boolean);
      DROP FUNCTION "${schemaName}".projection_operator(boolean, boolean);
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await pool.query(`
      CREATE SCHEMA "${foreignSchemaName}";
      CREATE TABLE "${foreignSchemaName}".projection_grants (
        session_id UUID NOT NULL,
        user_id UUID NOT NULL,
        allowed BOOLEAN NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${foreignSchemaName}".projection_grants;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toThrow(/project schema/i)
    await pool.query(`
      CREATE TABLE "${schemaName}".projection_grants_partitioned (
        session_id UUID NOT NULL,
        user_id UUID NOT NULL,
        allowed BOOLEAN NOT NULL,
        PRIMARY KEY (session_id, user_id, allowed)
      ) PARTITION BY LIST (allowed);
      CREATE TABLE "${schemaName}".projection_grants_true
        PARTITION OF "${schemaName}".projection_grants_partitioned FOR VALUES IN (TRUE);
      CREATE TABLE "${schemaName}".projection_grants_false
        PARTITION OF "${schemaName}".projection_grants_partitioned FOR VALUES IN (FALSE);
      INSERT INTO "${schemaName}".projection_grants_partitioned
      SELECT * FROM "${schemaName}".projection_grants;
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        DETACH PARTITION "${schemaName}".projection_grants_false;
      ALTER TABLE "${schemaName}".projection_grants_false SET SCHEMA "${foreignSchemaName}";
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        ATTACH PARTITION "${foreignSchemaName}".projection_grants_false FOR VALUES IN (FALSE);
      CREATE VIEW "${schemaName}".access_projection_source AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants_partitioned;
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".access_projection_source;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
    `)
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toThrow(/project schema/i)
    await pool.query(`
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        DETACH PARTITION "${foreignSchemaName}".projection_grants_false;
      ALTER TABLE "${foreignSchemaName}".projection_grants_false SET SCHEMA "${schemaName}";
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        ATTACH PARTITION "${schemaName}".projection_grants_false FOR VALUES IN (FALSE);
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".access_projection_source;
      REVOKE ALL ON "${schemaName}".access_projection FROM PUBLIC;
      DROP SCHEMA "${foreignSchemaName}" CASCADE;
    `)
    foreignSchemaName = ''

    let preview = await previewAuthorizationProjection(projectId, contract, platformUserId)
    const applied = await applyAuthorizationProjection(projectId, preview.operationId, {
      projectAlias, sourceDigest: preview.sourceDigest, targetDigest: preview.targetDigest,
      dependencyDigest: preview.dependencyDigest, baselineRevisions: preview.baselineRevisions,
    })
    expect(applied.status).toBe('completed')
    await expect(applyAuthorizationProjection(projectId, preview.operationId, {
      projectAlias, sourceDigest: preview.sourceDigest, targetDigest: preview.targetDigest,
      dependencyDigest: preview.dependencyDigest, baselineRevisions: preview.baselineRevisions,
    })).resolves.toMatchObject({ status: 'completed' })

    const sourceSnapshot = await pool.query<{ source_metadata: Record<string, unknown> }>(
      `SELECT source_metadata FROM druvia_data_access_projection_operations
       WHERE project_id = $1 AND operation_id = $2`,
      [projectId, preview.operationId]
    )
    const beforeSourceRestore = await hasuraMetadataRequestWithOptions<{
      resource_version: number
      metadata: Record<string, unknown>
    }>('export_metadata', {}, { version: 2 })
    await hasuraMetadataRequestWithOptions('replace_metadata', {
      allow_inconsistent_metadata: false,
      metadata: sourceSnapshot.rows[0].source_metadata,
    }, { resourceVersion: BigInt(beforeSourceRestore.resource_version) })
    await expect(recoverAuthorizationProjection(projectId, preview.operationId, projectAlias))
      .resolves.toMatchObject({ status: 'failed' })
    const role = resolveDataScopeRole({ projectId, actor: 'authenticated' })
    const root = `${schemaName}_projection_orders`
    const sourceDriftClosed = await graphql(role, ownerA, `query { ${root} { value } }`)
    expect(sourceDriftClosed.errors).toBeDefined()

    preview = await previewAuthorizationProjection(projectId, contract, platformUserId)
    await expect(applyAuthorizationProjection(projectId, preview.operationId, {
      projectAlias, sourceDigest: preview.sourceDigest, targetDigest: preview.targetDigest,
      dependencyDigest: preview.dependencyDigest, baselineRevisions: preview.baselineRevisions,
    })).resolves.toMatchObject({ status: 'completed' })

    await pool.query(`
      CREATE OR REPLACE VIEW "${schemaName}".access_projection_source AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants_partitioned
      WHERE session_id IS NOT NULL;
    `)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'dependency_invalid' })
    await pool.query(`
      CREATE OR REPLACE VIEW "${schemaName}".access_projection_source AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants_partitioned;
    `)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'managed' })

    foreignSchemaName = `${schemaName}_foreign`
    await pool.query(`
      CREATE SCHEMA "${foreignSchemaName}";
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        DETACH PARTITION "${schemaName}".projection_grants_false;
      ALTER TABLE "${schemaName}".projection_grants_false SET SCHEMA "${foreignSchemaName}";
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        ATTACH PARTITION "${foreignSchemaName}".projection_grants_false FOR VALUES IN (FALSE);
    `)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'dependency_invalid' })
    await pool.query(`
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        DETACH PARTITION "${foreignSchemaName}".projection_grants_false;
      ALTER TABLE "${foreignSchemaName}".projection_grants_false SET SCHEMA "${schemaName}";
      ALTER TABLE "${schemaName}".projection_grants_partitioned
        ATTACH PARTITION "${schemaName}".projection_grants_false FOR VALUES IN (FALSE);
      DROP SCHEMA "${foreignSchemaName}";
    `)
    foreignSchemaName = ''
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'managed' })

    const supersededPreview = await previewAuthorizationProjection(projectId, contract, platformUserId)
    const failedPreview = await previewAuthorizationProjection(projectId, contract, platformUserId)
    await pool.query(
      `UPDATE druvia_data_access_projection_operations
       SET status = 'failed', phase = 'completed', completed_at = NOW(),
           error_code = 'INTEGRATION_PREVIEW_FAILURE', error_message = 'Test preview failure'
       WHERE project_id = $1 AND operation_id = $2 AND status = 'preview_ready'`,
      [projectId, failedPreview.operationId]
    )
    await expect(pool.query<{ status: string }>(
      `SELECT status FROM druvia_data_access_projection_operations
       WHERE project_id = $1 AND operation_id = $2`,
      [projectId, supersededPreview.operationId]
    )).resolves.toMatchObject({ rows: [{ status: 'superseded' }] })
    await expect(getActiveAuthorizationProjection(projectId))
      .resolves.toMatchObject({ operationId: preview.operationId, status: 'completed' })
    const blockingPreview = await previewAuthorizationProjection(projectId, contract, platformUserId)
    await expect(getActiveAuthorizationProjection(projectId))
      .resolves.toMatchObject({ operationId: preview.operationId, status: 'completed' })

    const baselineBefore = await pool.query<{
      dependency_digest: string
    }>(
      `SELECT dependency_digest FROM druvia_data_access_managed_policies
       WHERE project_id = $1 AND schema_name = $2 AND table_name = 'projection_orders'`,
      [projectId, schemaName]
    )
    await pool.query(`ALTER TABLE "${schemaName}".projection_orders
      ADD COLUMN new_column TEXT, DROP COLUMN legacy_note`)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'refresh_required' })
    await expect(previewAuthorizationProjection(projectId, contract, platformUserId))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_PROJECTION_CONFLICT' })

    const reconcile = await previewPolicyReconcile(
      projectId, 'projection_orders', platformUserId
    )
    expect(reconcile.policy.policyVersion).toBe(2)
    expect(reconcile.columnGrants.authenticated.select).not.toContain('new_column')
    expect(reconcile.columnGrants.authenticated.select).not.toContain('legacy_note')
    await applyPolicyReconcile(projectId, 'projection_orders', {
      operationId: reconcile.operation.operationId,
      sourceDigest: reconcile.operation.sourceDigest,
      targetDigest: reconcile.operation.targetDigest!,
      baselineRevision: reconcile.baselineRevision!,
      projectAlias,
      columnGrants: reconcile.columnGrants,
      policy: reconcile.policy,
    }, platformUserId, () => getTableDataAccess(projectId, 'projection_orders'))
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'managed', policy: { policyVersion: 2 } })
    const baselineAfter = await pool.query<{
      dependency_digest: string
      column_grants: { authenticated: { select: string[] } }
    }>(
      `SELECT dependency_digest, column_grants
       FROM druvia_data_access_managed_policies
       WHERE project_id = $1 AND schema_name = $2 AND table_name = 'projection_orders'`,
      [projectId, schemaName]
    )
    expect(baselineAfter.rows[0].dependency_digest).toBe(
      baselineBefore.rows[0].dependency_digest
    )
    expect(baselineAfter.rows[0].column_grants.authenticated.select).not.toContain('new_column')

    const visibleA = await graphql(role, ownerA, `query { ${root}(order_by: { value: asc }) { value } }`)
    expect(visibleA).toEqual({ data: { [root]: [{ value: 'allowed-a' }] } })
    const visibleB = await graphql(role, ownerB, `query { ${root} { value } }`)
    expect(visibleB).toEqual({ data: { [root]: [{ value: 'allowed-b' }] } })

    const relationshipProbe = await graphql(
      role, ownerA, `query { ${root} { value access_projection { allowed } } }`
    )
    expect(relationshipProbe.errors).toBeDefined()
    const viewProbe = await graphql(role, ownerA, `query { ${schemaName}_access_projection { allowed } }`)
    expect(viewProbe.errors).toBeDefined()

    const newId = randomUUID()
    const mutation = await graphql(
      role,
      ownerA,
      `mutation($id: uuid!) {
        insert_${root}(objects: [{ id: $id, value: "new" }]) { affected_rows }
      }`,
      { id: newId }
    )
    expect(mutation).toEqual({ data: { [`insert_${root}`]: { affected_rows: 1 } } })
    const hidden = await graphql(role, ownerA, `query { ${root}(where: { id: { _eq: "${newId}" } }) { value } }`)
    expect(hidden).toEqual({ data: { [root]: [] } })

    const returningId = randomUUID()
    const returning = await graphql(
      role,
      ownerA,
      `mutation($id: uuid!) {
        insert_${root}(objects: [{ id: $id, value: "returning-secret" }]) {
          affected_rows
          returning { id value }
        }
      }`,
      { id: returningId }
    )
    expect(returning).toEqual({
      data: {
        [`insert_${root}`]: {
          affected_rows: 1,
          returning: [{ id: returningId, value: 'returning-secret' }],
        },
      },
    })

    const insertOneId = randomUUID()
    const insertOne = await graphql(
      role,
      ownerA,
      `mutation($id: uuid!) {
        insert_${root}_one(object: { id: $id, value: "insert-one-secret" }) { id value }
      }`,
      { id: insertOneId }
    )
    expect(insertOne).toEqual({
      data: {
        [`insert_${root}_one`]: { id: insertOneId, value: 'insert-one-secret' },
      },
    })
    for (const id of [returningId, insertOneId]) {
      await expect(graphql(
        role, ownerA, `query { ${root}(where: { id: { _eq: "${id}" } }) { value } }`
      )).resolves.toEqual({ data: { [root]: [] } })
    }

    await hasuraMetadataRequest('reload_metadata', { reload_sources: true })
    const reloaded = await graphql(role, ownerA, `query { ${root}(order_by: { value: asc }) { value } }`)
    expect(reloaded).toEqual({ data: { [root]: [{ value: 'allowed-a' }] } })

    await pool.query(`ALTER VIEW "${schemaName}".access_projection SET (security_invoker = true)`)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'dependency_invalid' })
    await pool.query(`ALTER VIEW "${schemaName}".access_projection RESET (security_invoker)`)

    await pool.query(`
      CREATE OR REPLACE VIEW "${schemaName}".access_projection
      WITH (security_barrier = true) AS
      SELECT session_id, user_id, allowed
      FROM "${schemaName}".projection_grants
      WHERE session_id IS NOT NULL;
    `)
    await expect(getTableDataAccess(projectId, 'projection_orders'))
      .resolves.toMatchObject({ managedState: 'dependency_invalid' })
    await expect(recoverAuthorizationProjection(projectId, preview.operationId, projectAlias))
      .resolves.toMatchObject({ status: 'failed' })
    await expect(pool.query<{ status: string }>(
      `SELECT status FROM druvia_data_access_projection_operations
       WHERE project_id = $1 AND operation_id = $2`,
      [projectId, blockingPreview.operationId]
    )).resolves.toMatchObject({ rows: [{ status: 'superseded' }] })
    const failedClosed = await graphql(role, ownerA, `query { ${root} { value } }`)
    expect(failedClosed.errors).toBeDefined()
  }, 30_000)

  async function graphql(
    role: string,
    userId: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${config.hasura.endpoint}/v1/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': config.hasura.adminSecret,
        'x-hasura-role': role,
        'x-hasura-user-id': userId,
      },
      body: JSON.stringify({ query, variables }),
    })
    return response.json() as Promise<Record<string, unknown>>
  }
})
