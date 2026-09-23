import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/middleware/ratelimit.js', () => ({
  createRateLimiter: () => async () => undefined,
  checkProjectGraphqlRateLimit: async () => undefined,
}))

import { config } from '../../apps/api/src/config/index.js'
import { pool } from '../../apps/api/src/db/index.js'
import { signProjectUserToken } from '../../apps/api/src/middleware/auth.js'
import type { ProjectActorContext } from '../../apps/api/src/lib/project-actor.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import { internalFunctionsGraphqlRoutes } from '../../apps/api/src/modules/functions/internal-graphql.routes.js'
import { signInternalFunctionToken } from '../../apps/api/src/modules/functions/internal-token.js'
import { openapiRoutes } from '../../apps/api/src/modules/openapi/openapi.routes.js'
import { clearSignatureCache, createRpcService } from '../../apps/api/src/modules/rpc/rpc.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'

const runIntegration = process.env.DRUVIA_RUN_PROJECT_ACTOR_INTEGRATION === '1'
const TABLE_NAME = 'actor_owned_rows'

describe.skipIf(!runIntegration)('Project Actor RPC and Functions against PostgreSQL and Hasura', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const rpcSchema = `actor_rpc_${suffix}`
  const createdProjects: Array<{ projectId: string; schemaName: string }> = []
  let dedicatedPool: Pool
  let app: FastifyInstance
  let tenantId = ''
  let platformUserId = ''
  let platformUid = 0
  let projectA!: { projectId: string; schemaName: string }
  let projectB!: { projectId: string; schemaName: string }
  let originalAdminSecret = ''

  const projectUserActor = (projectId: string): ProjectActorContext => ({
    version: 1,
    actorType: 'project_user',
    source: 'project_session',
    projectId,
    subject: 'project_user:pusr_owner',
    role: 'authenticated',
    projectUserId: 'pusr_owner',
    provider: 'integration',
  })

  const apiKeyActor = (projectId: string): ProjectActorContext => ({
    version: 1,
    actorType: 'apikey',
    source: 'project_api_key',
    projectId,
    subject: 'apikey:1701',
    role: 'anon',
    apiKeyId: 1701,
    apiKeyPrefix: 'drv_int',
  })

  const platformActor = (projectId: string): ProjectActorContext => ({
    version: 1,
    actorType: 'platform_user',
    source: 'platform_session',
    projectId,
    subject: `platform_user:${platformUserId}`,
    role: 'user',
    platformUserId,
    platformUid,
    tenantId,
  })

  async function metadataRequest(type: string, args: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${config.hasura.endpoint}/v1/metadata`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': config.hasura.adminSecret,
      },
      body: JSON.stringify({ type, args }),
    })
    if (!response.ok) {
      throw new Error(`Hasura metadata ${type} failed: ${await response.text()}`)
    }
  }

  function internalToken(actor: ProjectActorContext): string {
    return signInternalFunctionToken({
      projectId: actor.projectId,
      functionName: 'actor-integration',
      actor,
      expiresIn: 120,
    })
  }

  beforeAll(async () => {
    const adminSecret = process.env.DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET || ''
    if (!adminSecret) {
      throw new Error('Project Actor integration requires DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET')
    }
    originalAdminSecret = config.hasura.adminSecret
    config.hasura.adminSecret = adminSecret

    dedicatedPool = new Pool({
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      database: config.database.database,
      max: 1,
    })
    await dedicatedPool.query(`CREATE SCHEMA "${rpcSchema}"`)
    await dedicatedPool.query(`
      CREATE FUNCTION "${rpcSchema}".actor_context()
      RETURNS jsonb
      LANGUAGE sql
      AS $$
        SELECT jsonb_build_object(
          'claims', current_setting('request.jwt.claims', true)::jsonb,
          'headers', current_setting('request.headers', true)::jsonb,
          'actor', current_setting('druvia.actor', true)::jsonb,
          'service_environment', current_setting('druvia.service_environment', true)
        )
      $$
    `)

    platformUserId = `actor-${suffix}`
    const user = await pool.query<{ id: number }>(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [platformUserId, `${platformUserId}@test.local`, `actor_${suffix}`]
    )
    platformUid = user.rows[0].id
    const tenant = await tenantService.createTenant({
      alias: `a${suffix}`.slice(0, 16),
      name: 'Project Actor Integration',
      ownerUid: platformUid,
    })
    tenantId = tenant.tenantId

    const first = await projectService.createProject({
      tenantId,
      alias: `p${suffix}`.slice(0, 16),
      name: 'Project Actor A',
    })
    const second = await projectService.createProject({
      tenantId,
      alias: `q${suffix}`.slice(0, 16),
      name: 'Project Actor B',
    })
    if (!first.schemaName || !second.schemaName) throw new Error('Integration project schema missing')
    projectA = { projectId: first.projectId, schemaName: first.schemaName }
    projectB = { projectId: second.projectId, schemaName: second.schemaName }
    createdProjects.push(projectA, projectB)

    await pool.query('UPDATE druvia_projects SET data_access_mode = $1 WHERE project_id IN ($2, $3)', [
      'explicit', projectA.projectId, projectB.projectId,
    ])
    await pool.query(
      `INSERT INTO druvia_project_runtime_contexts
         (project_id, service_environment, created_by, updated_by)
       VALUES ($1, 'sandbox', $3, $3), ($2, 'local', $3, $3)`,
      [projectA.projectId, projectB.projectId, platformUserId],
    )
    await pool.query(`
      CREATE TABLE "${projectA.schemaName}"."${TABLE_NAME}" (
        id serial PRIMARY KEY,
        owner_id text NOT NULL,
        label text NOT NULL
      )
    `)
    await pool.query(
      `INSERT INTO "${projectA.schemaName}"."${TABLE_NAME}" (owner_id, label)
       VALUES ($1, 'private'), ($2, 'private'), ($2, 'public')`,
      ['pusr_owner', 'pusr_other']
    )
    await pool.query(`
      CREATE FUNCTION "${projectA.schemaName}".require_graphql_project_session_context()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        session_variables jsonb := current_setting('hasura.user', true)::jsonb;
      BEGIN
        IF session_variables IS NULL
          OR session_variables ->> 'x-hasura-druvia-actor-contract-version' <> '1'
          OR session_variables ->> 'x-hasura-druvia-actor-type' <> 'project_user'
          OR session_variables ->> 'x-hasura-druvia-actor-source' <> 'project_session'
          OR session_variables ->> 'x-hasura-druvia-project-id' <> '${projectA.projectId.replaceAll("'", "''")}'
          OR session_variables ->> 'x-hasura-druvia-project-user-id' <> 'pusr_owner'
          OR session_variables ->> 'x-hasura-druvia-service-environment' <> 'sandbox'
        THEN
          RAISE EXCEPTION 'missing managed Project GraphQL actor context'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `)
    await pool.query(`
      CREATE TRIGGER require_graphql_project_session_context
      BEFORE INSERT ON "${projectA.schemaName}"."${TABLE_NAME}"
      FOR EACH ROW EXECUTE FUNCTION "${projectA.schemaName}".require_graphql_project_session_context()
    `)
    await metadataRequest('pg_track_table', {
      source: 'default',
      table: { schema: projectA.schemaName, name: TABLE_NAME },
    })
    await metadataRequest('pg_create_select_permission', {
      source: 'default',
      table: { schema: projectA.schemaName, name: TABLE_NAME },
      role: resolveDataScopeRole({ projectId: projectA.projectId, actor: 'authenticated' }),
      permission: {
        columns: ['id', 'owner_id', 'label'],
        filter: { owner_id: { _eq: 'X-Hasura-User-Id' } },
      },
    })
    await metadataRequest('pg_create_select_permission', {
      source: 'default',
      table: { schema: projectA.schemaName, name: TABLE_NAME },
      role: resolveDataScopeRole({ projectId: projectA.projectId, actor: 'anonymous' }),
      permission: {
        columns: ['id', 'owner_id', 'label'],
        filter: { label: { _eq: 'public' } },
      },
    })
    await metadataRequest('pg_create_insert_permission', {
      source: 'default',
      table: { schema: projectA.schemaName, name: TABLE_NAME },
      role: resolveDataScopeRole({ projectId: projectA.projectId, actor: 'authenticated' }),
      permission: {
        columns: ['owner_id', 'label'],
        check: { owner_id: { _eq: 'X-Hasura-User-Id' } },
      },
    })

    app = Fastify()
    await app.register(internalFunctionsGraphqlRoutes, { prefix: '/api' })
    await app.register(openapiRoutes, { prefix: '/api/v1' })
  }, 30_000)

  afterAll(async () => {
    const projectIds = createdProjects.map((project) => project.projectId)
    const schemaNames = [...createdProjects.map((project) => project.schemaName), rpcSchema]
    if (app) await app.close().catch(() => undefined)
    if (projectA?.schemaName) {
      await metadataRequest('pg_untrack_table', {
        source: 'default',
        table: { schema: projectA.schemaName, name: TABLE_NAME },
        cascade: true,
      }).catch(() => undefined)
    }
    for (const project of [...createdProjects].reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${project.schemaName}" CASCADE`).catch(() => undefined)
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [project.projectId]).catch(() => undefined)
    }
    if (tenantId) {
      await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
    }
    if (platformUid) {
      await pool.query('DELETE FROM druvia_users WHERE id = $1', [platformUid]).catch(() => undefined)
    }
    clearSignatureCache(`${rpcSchema}.actor_context`)
    if (dedicatedPool) {
      await dedicatedPool.query(`DROP SCHEMA IF EXISTS "${rpcSchema}" CASCADE`).catch(() => undefined)
      await dedicatedPool.end().catch(() => undefined)
    }

    const residue = await pool.query<{
      projects_exist: boolean
      tenant_exists: boolean
      user_exists: boolean
      schemas_exist: boolean
      function_exists: boolean
    }>(`
      SELECT
        EXISTS (
          SELECT 1 FROM druvia_projects WHERE project_id = ANY($1::text[])
        ) AS projects_exist,
        EXISTS (
          SELECT 1 FROM druvia_tenants WHERE tenant_id = $2
        ) AS tenant_exists,
        EXISTS (
          SELECT 1 FROM druvia_users WHERE id = $3
        ) AS user_exists,
        EXISTS (
          SELECT 1 FROM pg_namespace WHERE nspname = ANY($4::text[])
        ) AS schemas_exist,
        EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $5 AND p.proname = 'actor_context'
        ) AS function_exists
    `, [projectIds, tenantId, platformUid, schemaNames, rpcSchema])
    expect(residue.rows[0]).toEqual({
      projects_exist: false,
      tenant_exists: false,
      user_exists: false,
      schemas_exist: false,
      function_exists: false,
    })
    config.hasura.adminSecret = originalAdminSecret
  }, 30_000)

  it('propagates RPC claims and isolated service environments on the same physical connection', async () => {
    const rpc = createRpcService({
      query: (async (text: string, params?: unknown[]) => {
        const result = await dedicatedPool.query(text, params)
        return result.rows
      }) as never,
      getClient: async () => dedicatedPool.connect(),
    })

    const projectResult = await rpc.callFunction(
      rpcSchema,
      'actor_context',
      undefined,
      projectUserActor(projectA.projectId)
    ) as Record<string, Record<string, unknown>>
    expect(projectResult.claims).toMatchObject({
      sub: 'project_user:pusr_owner',
      project_id: projectA.projectId,
      actor_type: 'project_user',
      project_user_id: 'pusr_owner',
    })
    expect(projectResult.actor).toEqual(projectResult.claims)
    expect(projectResult.headers).toMatchObject({
      'x-druvia-actor-subject': 'project_user:pusr_owner',
    })
    expect(projectResult.service_environment).toBe('sandbox')

    const secondProjectResult = await rpc.callFunction(
      rpcSchema,
      'actor_context',
      undefined,
      projectUserActor(projectB.projectId)
    ) as Record<string, Record<string, unknown>>
    expect(secondProjectResult.service_environment).toBe('local')

    const repeatProjectResult = await rpc.callFunction(
      rpcSchema,
      'actor_context',
      undefined,
      projectUserActor(projectA.projectId)
    ) as Record<string, Record<string, unknown>>
    expect(repeatProjectResult.service_environment).toBe('sandbox')

    const platformResult = await rpc.callFunction(
      rpcSchema,
      'actor_context',
      undefined,
      platformActor(projectA.projectId)
    ) as Record<string, Record<string, unknown>>
    expect(platformResult.claims).toMatchObject({
      sub: `platform_user:${platformUserId}`,
      actor_type: 'platform_user',
      platform_user_id: platformUserId,
      platform_uid: platformUid,
    })

    const reused = await dedicatedPool.connect()
    try {
      await reused.query('BEGIN')
      const residue = await reused.query(`
        SELECT
          NULLIF(current_setting('request.jwt.claims', true), '') IS NULL AS claims_clear,
          NULLIF(current_setting('request.headers', true), '') IS NULL AS headers_clear,
          NULLIF(current_setting('druvia.actor', true), '') IS NULL AS actor_clear,
          NULLIF(current_setting('druvia.service_environment', true), '') IS NULL AS service_environment_clear
      `)
      await reused.query('COMMIT')
      expect(residue.rows[0]).toEqual({
        claims_clear: true,
        headers_clear: true,
        actor_clear: true,
        service_environment_clear: true,
      })
    } finally {
      reused.release()
    }
  })

  it('enforces owner and anonymous Hasura permissions for internal Function GraphQL', async () => {
    const rootField = `${projectA.schemaName}_${TABLE_NAME}`
    const query = `query { ${rootField}(order_by: { id: asc }) { owner_id label } }`
    const projectUserResponse = await app.inject({
      method: 'POST',
      url: '/api/internal/functions/graphql',
      headers: { 'x-druvia-internal-token': internalToken(projectUserActor(projectA.projectId)) },
      payload: { query },
    })
    expect(projectUserResponse.statusCode).toBe(200)
    expect(projectUserResponse.json().data[rootField]).toEqual([
      { owner_id: 'pusr_owner', label: 'private' },
    ])

    const apiKeyResponse = await app.inject({
      method: 'POST',
      url: '/api/internal/functions/graphql',
      headers: { 'x-druvia-internal-token': internalToken(apiKeyActor(projectA.projectId)) },
      payload: { query },
    })
    expect(apiKeyResponse.statusCode).toBe(200)
    expect(apiKeyResponse.json().data[rootField]).toEqual([
      { owner_id: 'pusr_other', label: 'public' },
    ])
  })

  it('makes the managed Project Session actor contract available to Function GraphQL triggers', async () => {
    const rootField = `insert_${projectA.schemaName}_${TABLE_NAME}_one`
    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/functions/graphql',
      headers: { 'x-druvia-internal-token': internalToken(projectUserActor(projectA.projectId)) },
      payload: {
        query: `mutation { ${rootField}(object: { owner_id: "pusr_owner", label: "function" }) { owner_id label } }`,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().errors).toBeUndefined()
    expect(response.json().data[rootField]).toEqual({ owner_id: 'pusr_owner', label: 'function' })
  })

  it('makes the managed Project Session actor contract available to GraphQL triggers', async () => {
    const accessToken = signProjectUserToken({
      sub: 'pusr_owner',
      projectId: projectA.projectId,
      authType: 'project_user',
      role: 'authenticated',
      provider: 'integration',
    }, 120)
    const rootField = `insert_${projectA.schemaName}_${TABLE_NAME}_one`
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectA.projectId}/graphql`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-hasura-druvia-actor-source': 'forged-source',
        'x-hasura-druvia-project-user-id': 'forged-user',
        'x-hasura-druvia-service-environment': 'production',
      },
      payload: {
        query: `mutation { ${rootField}(object: { owner_id: "pusr_owner", label: "graphql" }) { owner_id label } }`,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().errors).toBeUndefined()
    expect(response.json().data[rootField]).toEqual({ owner_id: 'pusr_owner', label: 'graphql' })
  })

  it('rejects Project Session JWTs and forged actor headers through direct Hasura access', async () => {
    const accessToken = signProjectUserToken({
      sub: 'pusr_owner',
      projectId: projectA.projectId,
      authType: 'project_user',
      role: 'authenticated',
      provider: 'integration',
    }, 120)

    const response = await fetch(`${config.hasura.endpoint}/v1/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-hasura-druvia-actor-contract-version': '1',
        'x-hasura-druvia-actor-type': 'project_user',
        'x-hasura-druvia-actor-source': 'project_session',
        'x-hasura-druvia-project-id': projectA.projectId,
        'x-hasura-druvia-project-user-id': 'pusr_owner',
      },
      body: JSON.stringify({ query: 'query { __typename }' }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      errors?: Array<{ extensions?: { code?: string } }>
    }
    expect(body.errors?.[0]?.extensions?.code).toMatch(/^(invalid-jwt|jwt-invalid-claims)$/)
  })

  it('rejects Platform and cross-project actors before Hasura execution', async () => {
    const rootField = `${projectA.schemaName}_${TABLE_NAME}`
    const query = `query { ${rootField} { id } }`
    const platformResponse = await app.inject({
      method: 'POST',
      url: '/api/internal/functions/graphql',
      headers: { 'x-druvia-internal-token': internalToken(platformActor(projectA.projectId)) },
      payload: { query },
    })
    expect(platformResponse.statusCode).toBe(403)
    expect(platformResponse.json().error.code).toBe('PROJECT_ACTOR_REQUIRED')

    const crossProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/internal/functions/graphql',
      headers: { 'x-druvia-internal-token': internalToken(apiKeyActor(projectB.projectId)) },
      payload: { query },
    })
    expect(crossProjectResponse.statusCode).toBe(403)
    expect(crossProjectResponse.json().error.code).toBe('FORBIDDEN')
  })
})
