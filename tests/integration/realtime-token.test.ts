import { randomUUID } from 'node:crypto'
import { createClient, type Client } from 'graphql-ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../../apps/api/src/config/index.js'
import { pool } from '../../apps/api/src/db/index.js'
import type { ApiKeyIdentity, ProjectJwtUser } from '../../apps/api/src/middleware/auth.js'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'
import { resolveRealtimeExecutionContext } from '../../apps/api/src/modules/realtime/realtime-actor.js'
import { issueRealtimeAccessToken } from '../../apps/api/src/modules/realtime/realtime-token.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'

const CONNECTION_TIMEOUT_MS = 4_000
const TABLE_NAME = 'realtime_events'

interface ProjectFixture {
  projectId: string
  schemaName: string
  rootField: string
  explicitUserRole: string
  explicitAnonRole: string
}

interface OpenConnection {
  client: Client
  acknowledged: Promise<void>
}

const activeClients = new Set<Client>()
const metadataEntries: Array<{ schemaName: string; roles: string[] }> = []
const createdProjects: Array<{ projectId: string; schemaName: string }> = []
let userId = 0
let tenantId = ''
let projectA: ProjectFixture
let projectB: ProjectFixture

function requireVerifierContract(): void {
  const rawVerifier = process.env.HASURA_GRAPHQL_JWT_SECRET
  if (!rawVerifier) {
    throw new Error(
      'Realtime integration requires HASURA_GRAPHQL_JWT_SECRET with type HS256, issuer druvia and audience druvia-hasura'
    )
  }

  let verifier: Record<string, unknown>
  try {
    verifier = JSON.parse(rawVerifier) as Record<string, unknown>
  } catch {
    throw new Error('HASURA_GRAPHQL_JWT_SECRET must be valid JSON for Realtime integration')
  }

  if (
    verifier.type !== 'HS256'
    || verifier.issuer !== 'druvia'
    || verifier.audience !== 'druvia-hasura'
  ) {
    throw new Error(
      'Running Hasura must verify HS256 tokens with issuer druvia and audience druvia-hasura'
    )
  }
  if (verifier.key !== process.env.HASURA_JWT_SECRET || verifier.key !== config.realtime.tokenSecret) {
    throw new Error('HASURA_JWT_SECRET must match the running Hasura verifier key')
  }
}

async function metadataRequest(type: string, args: Record<string, unknown>): Promise<void> {
  const adminSecret = process.env.DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET
  if (!adminSecret) {
    throw new Error(
      'Realtime integration requires HASURA_ADMIN_SECRET or DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET'
    )
  }

  const response = await fetch(`${config.hasura.endpoint}/v1/metadata`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret,
    },
    body: JSON.stringify({ type, args }),
  })
  if (!response.ok) {
    throw new Error(`Hasura metadata ${type} failed: ${await response.text()}`)
  }
}

async function createProjectFixture(alias: string): Promise<ProjectFixture> {
  const project = await projectService.createProject({
    tenantId,
    alias,
    name: `Realtime Token ${alias}`,
  })
  if (!project.schemaName) throw new Error('Integration project schema was not created')

  const schemaName = project.schemaName
  createdProjects.push({ projectId: project.projectId, schemaName })
  await pool.query(`
    CREATE TABLE "${schemaName}"."${TABLE_NAME}" (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL
    )
  `)
  await pool.query(
    `INSERT INTO "${schemaName}"."${TABLE_NAME}" (message) VALUES ($1)`,
    [`event-${alias}`]
  )
  await pool.query(
    `INSERT INTO "${schemaName}"._meta_tables (table_name, realtime_enabled)
     VALUES ($1, true)
     ON CONFLICT (table_name)
     DO UPDATE SET realtime_enabled = true, updated_at = NOW()`,
    [TABLE_NAME]
  )

  const explicitUserRole = resolveDataScopeRole({
    projectId: project.projectId,
    actor: 'authenticated',
  })
  const explicitAnonRole = resolveDataScopeRole({
    projectId: project.projectId,
    actor: 'anonymous',
  })
  const roles = ['user', 'anonymous', explicitUserRole, explicitAnonRole]

  await metadataRequest('pg_track_table', {
    source: 'default',
    table: { schema: schemaName, name: TABLE_NAME },
  })
  const metadataEntry = { schemaName, roles: [] as string[] }
  metadataEntries.push(metadataEntry)
  for (const role of roles) {
    await metadataRequest('pg_create_select_permission', {
      source: 'default',
      table: { schema: schemaName, name: TABLE_NAME },
      role,
      permission: { columns: '*', filter: {} },
    })
    metadataEntry.roles.push(role)
  }

  return {
    projectId: project.projectId,
    schemaName,
    rootField: `${schemaName}_${TABLE_NAME}`,
    explicitUserRole,
    explicitAnonRole,
  }
}

function projectUser(projectId: string): ProjectJwtUser {
  return {
    kind: 'project_user',
    sub: `project-user-${projectId}`,
    projectId,
    authType: 'project_user',
    role: 'authenticated',
    provider: 'integration',
  }
}

function apiKey(projectId: string): ApiKeyIdentity {
  return {
    kind: 'apikey', projectId, role: 'anon',
    apiKeyId: 42, apiKeyPrefix: 'dru_fixture1',
  }
}

function issueToken(
  project: ProjectFixture,
  actor: ProjectJwtUser | ApiKeyIdentity,
  runtimeMode: 'compatibility' | 'explicit',
  now?: Date
): string {
  return issueRealtimeAccessToken({
    projectId: project.projectId,
    context: resolveRealtimeExecutionContext({
      projectId: project.projectId,
      runtimeMode,
      actor,
    }),
    now,
  }).token
}

function tamperSignature(token: string): string {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments[2]) throw new Error('Expected a signed JWT')
  const first = segments[2][0]
  segments[2] = `${first === 'a' ? 'b' : 'a'}${segments[2].slice(1)}`
  return segments.join('.')
}

function openConnection(token?: string): OpenConnection {
  const websocketUrl = issueRealtimeAccessToken({
    projectId: projectA.projectId,
    context: resolveRealtimeExecutionContext({
      projectId: projectA.projectId,
      runtimeMode: 'explicit',
      actor: apiKey(projectA.projectId),
    }),
  }).websocketUrl
  let timeout: ReturnType<typeof setTimeout>
  let resolveAck: () => void
  let rejectAck: (error: Error) => void
  let settled = false
  const acknowledged = new Promise<void>((resolve, reject) => {
    resolveAck = resolve
    rejectAck = reject
    timeout = setTimeout(
      () => reject(new Error('Timed out waiting for connection_ack')),
      CONNECTION_TIMEOUT_MS
    )
  }).finally(() => clearTimeout(timeout))

  const settleSuccess = () => {
    if (settled) return
    settled = true
    resolveAck()
  }
  const settleFailure = (reason: unknown) => {
    if (settled) return
    settled = true
    const message = reason instanceof Error
      ? reason.message
      : `Realtime connection rejected: ${String(reason)}`
    rejectAck(new Error(message))
  }

  const client = createClient({
    url: websocketUrl,
    lazy: false,
    retryAttempts: 0,
    connectionAckWaitTimeout: CONNECTION_TIMEOUT_MS,
    connectionParams: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : {},
    onNonLazyError: () => undefined,
    on: {
      connected: settleSuccess,
      closed: settleFailure,
      error: settleFailure,
    },
  })
  activeClients.add(client)
  return { client, acknowledged }
}

async function dispose(client: Client): Promise<void> {
  activeClients.delete(client)
  await client.dispose()
}

async function firstSubscriptionResult(client: Client, rootField: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for subscription result')),
      CONNECTION_TIMEOUT_MS
    )
    const release = client.subscribe(
      { query: `subscription RealtimeTokenTest { ${rootField} { id message } }` },
      {
        next: (result) => {
          clearTimeout(timeout)
          release()
          if (result.errors?.length) reject(new Error(JSON.stringify(result.errors)))
          else resolve(result.data)
        },
        error: (error) => {
          clearTimeout(timeout)
          reject(new Error(JSON.stringify(error)))
        },
        complete: () => undefined,
      }
    )
  })
}

describe('Realtime access token against Hasura', () => {
  beforeAll(async () => {
    requireVerifierContract()
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    const userResult = await pool.query<{ id: number }>(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [`realtime-token-${suffix}`, `realtime-token-${suffix}@test.local`, `rt_${suffix}`]
    )
    userId = userResult.rows[0].id
    const tenant = await tenantService.createTenant({
      alias: `rt${suffix}`.slice(0, 16),
      name: 'Realtime Token Integration',
      ownerUid: userId,
    })
    tenantId = tenant.tenantId
    projectA = await createProjectFixture(`a${suffix}`.slice(0, 16))
    projectB = await createProjectFixture(`b${suffix}`.slice(0, 16))
  }, 30_000)

  afterAll(async () => {
    await Promise.all([...activeClients].map((client) => dispose(client)))

    for (const entry of metadataEntries.reverse()) {
      for (const role of entry.roles.reverse()) {
        try {
          await metadataRequest('pg_drop_select_permission', {
            source: 'default',
            table: { schema: entry.schemaName, name: TABLE_NAME },
            role,
          })
        } catch {
          // Continue cleanup after a partially completed fixture setup.
        }
      }
      try {
        await metadataRequest('pg_untrack_table', {
          source: 'default',
          table: { schema: entry.schemaName, name: TABLE_NAME },
          cascade: true,
        })
      } catch {
        // Continue database cleanup when Hasura is already unavailable.
      }
    }

    for (const project of createdProjects.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${project.schemaName}" CASCADE`)
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [project.projectId])
    }
    if (tenantId) await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [tenantId])
    if (userId) await pool.query('DELETE FROM druvia_users WHERE id = $1', [userId])
  }, 30_000)

  it('acknowledges a valid token', async () => {
    const connection = openConnection(issueToken(projectA, projectUser(projectA.projectId), 'explicit'))
    try {
      await expect(connection.acknowledged).resolves.toBeUndefined()
    } finally {
      await dispose(connection.client)
    }
  })

  it.each([
    ['tampered', () => tamperSignature(issueToken(projectA, apiKey(projectA.projectId), 'explicit'))],
    ['expired', () => issueToken(
      projectA,
      apiKey(projectA.projectId),
      'explicit',
      new Date(Date.now() - (config.realtime.tokenTtlSeconds + 10) * 1_000)
    )],
  ])('rejects a %s token', async (_label, tokenFactory) => {
    const connection = openConnection(tokenFactory())
    try {
      await expect(connection.acknowledged).rejects.toThrow()
    } finally {
      await dispose(connection.client)
    }
  })

  it('retains legacy anonymous no-token subscriptions', async () => {
    const connection = openConnection()
    try {
      await connection.acknowledged
      await expect(firstSubscriptionResult(connection.client, projectA.rootField)).resolves.toHaveProperty(
        projectA.rootField
      )
    } finally {
      await dispose(connection.client)
    }
  })

  it('denies a project A scoped token access to project B', async () => {
    const connection = openConnection(issueToken(projectA, projectUser(projectA.projectId), 'explicit'))
    try {
      await connection.acknowledged
      await expect(firstSubscriptionResult(connection.client, projectB.rootField)).rejects.toThrow()
    } finally {
      await dispose(connection.client)
    }
  })

  it('maps a compatibility API key token to the legacy anonymous permission', async () => {
    const connection = openConnection(issueToken(projectA, apiKey(projectA.projectId), 'compatibility'))
    try {
      await connection.acknowledged
      await expect(firstSubscriptionResult(connection.client, projectA.rootField)).resolves.toHaveProperty(
        projectA.rootField
      )
    } finally {
      await dispose(connection.client)
    }
  })

  it.each([
    ['Project User', () => issueToken(projectA, projectUser(projectA.projectId), 'explicit')],
    ['API key', () => issueToken(projectA, apiKey(projectA.projectId), 'explicit')],
  ])('uses scoped permissions for an explicit %s actor', async (_label, tokenFactory) => {
    const connection = openConnection(tokenFactory())
    try {
      await connection.acknowledged
      await expect(firstSubscriptionResult(connection.client, projectA.rootField)).resolves.toHaveProperty(
        projectA.rootField
      )
    } finally {
      await dispose(connection.client)
    }
  })
})
