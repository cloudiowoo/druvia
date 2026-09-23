import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { materializeTableDataAccessPolicy } from '../../apps/api/src/modules/data-access/data-access-policy.js'

const enabled = process.env.DRUVIA_RUN_HASURA_ENV_PROJECTION_INTEGRATION === '1'
const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const network = `druvia-env-projection-${suffix}`
const postgres = `${network}-pg`
const hasura = `${network}-hasura`
const secret = 'isolated-integration-only'
const userA = '11111111-1111-1111-1111-111111111111'
const userB = '22222222-2222-2222-2222-222222222222'
let url = ''
let networkCreated = false

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim()
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Isolated ${label} did not become healthy`)
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': secret, ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const query = (headers: Record<string, string>, document: string) => post(
  '/v1/graphql', { query: document }, { 'x-hasura-role': 'spike_user', ...headers }
)
const actor = (user: string, environment?: string) => ({
  'x-hasura-user-id': user,
  ...(environment ? { 'x-hasura-druvia-service-environment': environment } : {}),
})

describe.skipIf(!enabled)('environment-scoped projection with isolated Hasura CE 2.48.0', () => {
  beforeAll(async () => {
    docker('network', 'create', network)
    networkCreated = true
    docker('run', '-d', '--rm', '--name', postgres, '--network', network,
      '-e', `POSTGRES_PASSWORD=${secret}`, '-e', 'POSTGRES_DB=spike', 'postgres:17-alpine')
    await waitFor(async () => {
      const result = spawnSync('docker', ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'spike'])
      return result.status === 0
    }, 'PostgreSQL')
    const sql = `
      BEGIN;
      CREATE SCHEMA spike;
      CREATE TABLE spike.football_session (id uuid PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL);
      CREATE TABLE spike.grant_entry (
        session_id uuid NOT NULL, user_id uuid NOT NULL,
        service_environment text NOT NULL, allowed boolean NOT NULL
      );
      INSERT INTO spike.football_session VALUES
        ('00000000-0000-0000-0000-000000000001', '${userA}', 'sandbox'),
        ('00000000-0000-0000-0000-000000000002', '${userA}', 'local'),
        ('00000000-0000-0000-0000-000000000003', '${userA}', 'no grant'),
        ('00000000-0000-0000-0000-000000000004', '${userB}', 'other user');
      INSERT INTO spike.grant_entry VALUES
        ('00000000-0000-0000-0000-000000000001', '${userA}', 'sandbox', true),
        ('00000000-0000-0000-0000-000000000002', '${userA}', 'local', true),
        ('00000000-0000-0000-0000-000000000004', '${userB}', 'sandbox', true);
      CREATE VIEW spike.session_access_projection WITH (security_barrier = true) AS
        SELECT session_id, user_id,
          jsonb_object_agg(service_environment, true) FILTER (WHERE allowed) AS allowed_environments,
          bool_or(allowed) AS can_read_basic
        FROM spike.grant_entry GROUP BY session_id, user_id;
      REVOKE ALL ON spike.session_access_projection FROM PUBLIC;
      COMMIT;
    `
    await waitFor(async () => {
      const result = spawnSync('docker', ['exec', '-i', postgres, 'psql', '-v', 'ON_ERROR_STOP=1',
        '-U', 'postgres', '-d', 'spike'], { input: sql, encoding: 'utf8' })
      if (result.status === 0) return true
      if (/database system is (shutting down|starting up)/i.test(result.stderr)) return false
      throw new Error(`Isolated SQL setup failed: ${result.stderr}`)
    }, 'SQL setup')

    docker('run', '-d', '--rm', '--name', hasura, '--network', network,
      '-p', '127.0.0.1::8080',
      '-e', `HASURA_GRAPHQL_DATABASE_URL=postgres://postgres:${secret}@${postgres}:5432/spike`,
      '-e', `HASURA_GRAPHQL_ADMIN_SECRET=${secret}`,
      'hasura/graphql-engine:v2.48.0')
    url = `http://${docker('port', hasura, '8080/tcp')}`
    await waitFor(async () => {
      try { return (await fetch(`${url}/healthz`)).ok } catch { return false }
    }, 'Hasura')

    const roles = { authenticated: 'spike_user', anonymous: 'spike_anon' }
    const capabilities = { readableColumns: ['id', 'user_id', 'title'],
      insertableColumns: ['id', 'user_id', 'title'], updateableColumns: ['id', 'user_id', 'title'] }
    const permissions = materializeTableDataAccessPolicy({
      policyVersion: 2,
      authenticated: {
        select: 'owner', insert: 'owner', update: 'none', delete: 'none', ownerColumn: 'user_id',
        selectConstraint: { type: 'authorization_projection',
          relationshipPath: ['session_access_projection'], actorColumn: 'user_id',
          allowColumn: 'can_read_basic', environmentColumn: 'allowed_environments' },
      },
      anonymous: { select: false },
    }, { roles, capabilities })
    const table = { schema: 'spike', name: 'football_session' }
    const operations = [
      { type: 'pg_track_table', args: { source: 'default', table } },
      { type: 'pg_track_table', args: { source: 'default', table: { schema: 'spike', name: 'session_access_projection' } } },
      { type: 'pg_create_object_relationship', args: { source: 'default', table,
        name: 'session_access_projection', using: { manual_configuration: {
          remote_table: { schema: 'spike', name: 'session_access_projection' },
          column_mapping: { id: 'session_id', user_id: 'user_id' },
        } } } },
      ...permissions.map(({ role, operation, permission }) => ({
        type: `pg_create_${operation}_permission`, args: { source: 'default', table, role, permission },
      })),
    ]
    const setup = await post('/v1/metadata', { type: 'bulk', args: operations })
    if (setup.status !== 200) throw new Error(`Isolated metadata setup failed: ${JSON.stringify(setup.body)}`)
  }, 60_000)

  afterAll(() => {
    for (const name of [hasura, postgres]) {
      spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 20_000 })
    }
    if (networkCreated) spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8' })
  }, 60_000)

  it('limits list and primary-key reads to the actor and configured environment', async () => {
    const list = '{ spike_football_session(order_by:{id:asc}) { title } }'
    expect((await query(actor(userA, 'sandbox'), list)).body).toEqual({
      data: { spike_football_session: [{ title: 'sandbox' }] },
    })
    expect((await query(actor(userA, 'local'), list)).body).toEqual({
      data: { spike_football_session: [{ title: 'local' }] },
    })
    expect((await query(actor(userB, 'sandbox'), list)).body).toEqual({
      data: { spike_football_session: [{ title: 'other user' }] },
    })
    expect((await query(actor(userA, 'production'), list)).body).toEqual({
      data: { spike_football_session: [] },
    })
    const pk = (id: string) => `{ spike_football_session_by_pk(id:"${id}") { title } }`
    for (const id of ['00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000004']) {
      expect((await query(actor(userA, 'sandbox'), pk(id))).body).toEqual({
        data: { spike_football_session_by_pk: null },
      })
    }
    expect((await query(actor(userA), list)).body.errors).toBeDefined()
  })

  it('keeps projection data private while allowing affected_rows-only writes', async () => {
    for (const document of [
      '{ spike_session_access_projection { session_id } }',
      '{ spike_football_session { session_access_projection { session_id } } }',
    ]) expect((await query(actor(userA, 'sandbox'), document)).body.errors).toBeDefined()

    const id = '00000000-0000-0000-0000-000000000099'
    const inserted = await query(actor(userA, 'sandbox'),
      `mutation { insert_spike_football_session(objects:[{id:"${id}",title:"candidate"}]) { affected_rows } }`)
    expect(inserted.body).toEqual({
      data: { insert_spike_football_session: { affected_rows: 1 } },
    })
    expect((await query(actor(userA, 'sandbox'), '{ spike_football_session { title } }')).body).toEqual({
      data: { spike_football_session: [{ title: 'sandbox' }] },
    })
  })
})
