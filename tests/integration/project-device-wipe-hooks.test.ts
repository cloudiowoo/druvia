import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../apps/api/src/db/index.js'
import { inspectDeviceWipeHookContracts } from '../../apps/api/src/modules/project-auth/project-device-wipe.hooks.js'

const runIntegration = process.env.DRUVIA_RUN_DEVICE_WIPE_HOOK_INTEGRATION === '1'

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

describe.skipIf(!runIntegration)('device wipe Hook inspection against PostgreSQL', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const projectId = `dw_hook_${suffix}`
  const projectAlias = `dw${suffix}`.slice(0, 16)
  const schemaName = `dw_hook_${suffix}`
  const ownerRole = `dw_hook_${suffix}_user`
  const foreignSchema = `dw_other_${suffix}`
  const names = {
    registerFunction: 'druvia_register_device_wipe_binding',
    queryFunction: 'druvia_list_device_wipe_mandates',
    acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
  }

  beforeAll(async () => {
    const tenant = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM druvia_tenants ORDER BY id LIMIT 1',
    )
    if (!tenant.rows[0]) throw new Error('Device Wipe Hook integration requires an existing tenant')

    await pool.query(`CREATE ROLE ${identifier(ownerRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`)
    await pool.query(`CREATE SCHEMA ${identifier(schemaName)} AUTHORIZATION ${identifier(ownerRole)}`)
    await pool.query(`CREATE SCHEMA ${identifier(foreignSchema)}`)
    await pool.query(`CREATE TABLE ${identifier(foreignSchema)}.ordinary_relation (id bigint PRIMARY KEY)`)
    await pool.query(
      `INSERT INTO druvia_projects (project_id, tenant_id, alias, name, schema_name, db_user, data_access_mode)
       VALUES ($1, $2, $3, 'Device Wipe Hook Integration', $4, $5, 'explicit')`,
      [projectId, tenant.rows[0].tenant_id, projectAlias, schemaName, ownerRole],
    )

    const functions = [
      `${identifier(schemaName)}.${identifier(names.registerFunction)}(text, text, bigint)`,
      `${identifier(schemaName)}.${identifier(names.queryFunction)}(text, bigint)`,
      `${identifier(schemaName)}.${identifier(names.acknowledgeFunction)}(text, bigint, uuid, jsonb)`,
    ]
    const bodies = [
      `SELECT '{"registered":true}'::jsonb`,
      `SELECT '[]'::jsonb`,
      `SELECT '{"acknowledged":true}'::jsonb`,
    ]

    for (let index = 0; index < functions.length; index += 1) {
      await pool.query(
        `CREATE FUNCTION ${functions[index]}
         RETURNS jsonb
         LANGUAGE sql
         SECURITY DEFINER
         SET search_path = pg_catalog, ${identifier(schemaName)}, pg_temp
         AS $function$ ${bodies[index]} $function$`,
      )
      await pool.query(`ALTER FUNCTION ${functions[index]} OWNER TO ${identifier(ownerRole)}`)
      await pool.query(`REVOKE ALL ON FUNCTION ${functions[index]} FROM PUBLIC`)
    }
  })

  afterAll(async () => {
    const cleanupErrors: unknown[] = []
    const cleanup = async (operation: () => Promise<unknown>) => {
      try {
        await operation()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    await cleanup(() => pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [projectId]))
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`))
    await cleanup(() => pool.query(`DROP SCHEMA IF EXISTS ${identifier(foreignSchema)} CASCADE`))
    await cleanup(() => pool.query(`DROP ROLE IF EXISTS ${identifier(ownerRole)}`))

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Device Wipe Hook integration cleanup failed')
    }
  })

  it('does not evaluate sequence privileges for ordinary foreign relations', async () => {
    const client = await pool.connect()
    try {
      const contracts = await inspectDeviceWipeHookContracts(client, projectId, names)

      expect(contracts).toMatchObject({
        schemaName,
        registerFunction: names.registerFunction,
        queryFunction: names.queryFunction,
        acknowledgeFunction: names.acknowledgeFunction,
      })
      expect(contracts.registerContractHash).toMatch(/^[a-f0-9]{64}$/)
      expect(contracts.queryContractHash).toMatch(/^[a-f0-9]{64}$/)
      expect(contracts.acknowledgeContractHash).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      client.release()
    }
  })
})
