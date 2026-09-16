import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildProjectionRollbackCheckSql,
  buildProjectionRollbackGateSql,
  buildProjectionRollbackLockHolderSql,
  buildProjectionRollbackLockReadySql,
  buildProjectionRollbackLockReleaseWaitSql,
} from '../../apps/updater/src/compose.js'

const enabled = process.env.DRUVIA_RUN_UPDATER_ROLLBACK_GATE_INTEGRATION === '1'
const suite = enabled ? describe : describe.skip
const schemaName = `rollback_gate_${randomUUID().replaceAll('-', '')}`
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.DB_NAME || 'druvia',
})

suite('updater projection rollback gate', () => {
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    await pool.query(`CREATE TABLE "${schemaName}".druvia_data_access_managed_policies (
      policy_version integer NOT NULL DEFAULT 1
    )`)
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await pool.end()
  })

  it('supports pre-027 columns and rejects any projection provenance', async () => {
    const sql = buildProjectionRollbackCheckSql(schemaName)
    await expect(pool.query(buildProjectionRollbackGateSql('enable', schemaName))).resolves.toBeDefined()
    await expect(pool.query(buildProjectionRollbackGateSql('disable', schemaName))).resolves.toBeDefined()
    await expect(pool.query(sql)).resolves.toBeDefined()
    await pool.query(`INSERT INTO "${schemaName}".druvia_data_access_managed_policies DEFAULT VALUES`)
    await expect(pool.query(sql)).resolves.toBeDefined()

    await pool.query(`CREATE TABLE "${schemaName}".druvia_data_access_projection_operations (id bigint)`)
    await pool.query(`INSERT INTO "${schemaName}".druvia_data_access_projection_operations VALUES (1)`)
    await expect(pool.query(sql)).rejects.toThrow(/prevents file-only rollback/)
    await pool.query(`DROP TABLE "${schemaName}".druvia_data_access_projection_operations`)

    await pool.query(`ALTER TABLE "${schemaName}".druvia_data_access_managed_policies
      ADD COLUMN dependency_snapshot jsonb, ADD COLUMN dependency_digest text`)
    await expect(pool.query(sql)).resolves.toBeDefined()
    await pool.query(`UPDATE "${schemaName}".druvia_data_access_managed_policies
      SET dependency_snapshot = '{}'::jsonb, dependency_digest = repeat('a', 64)`)
    await expect(pool.query(sql)).rejects.toThrow(/prevents file-only rollback/)
    await pool.query(`UPDATE "${schemaName}".druvia_data_access_managed_policies
      SET dependency_snapshot = NULL, dependency_digest = NULL`)
  })

  it('holds the global mutation lock without a migration-027 gate table until explicit release', async () => {
    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    const settled = holder.then(() => undefined, () => undefined)
    try {
      let ready = false
      for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
        try {
          await pool.query(buildProjectionRollbackLockReadySql(schemaName))
          ready = true
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      expect(ready).toBe(true)
      const check = await pool.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock_shared(hashtextextended('data-access-mutation:global', 0)) AS acquired`
      )
      expect(check.rows[0]?.acquired).toBe(false)
      await pool.query(buildProjectionRollbackLockReleaseWaitSql(schemaName, true))
      await settled
      await expect(pool.query(buildProjectionRollbackLockReadySql(schemaName)))
        .rejects.toThrow(/holder is not ready/)
    } finally {
      await pool.query(buildProjectionRollbackLockReleaseWaitSql(schemaName))
      await settled
    }
  })

  it('persists the rollback gate and drains existing shared mutation locks', async () => {
    await pool.query(`CREATE TABLE "${schemaName}".druvia_data_access_runtime_gates (
      gate_name text PRIMARY KEY,
      active boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    await expect(pool.query<{ active: boolean }>(
      `SELECT active FROM "${schemaName}".druvia_data_access_runtime_gates
       WHERE gate_name = 'file_rollback'`
    )).resolves.toMatchObject({ rows: [{ active: true }] })

    const mutationClient = await pool.connect()
    let checkSettled = false
    try {
      await mutationClient.query(
        `SELECT pg_advisory_lock_shared(hashtextextended('data-access-mutation:global', 0))`
      )
      const check = pool.query(buildProjectionRollbackCheckSql(schemaName))
        .finally(() => { checkSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(checkSettled).toBe(false)
      await mutationClient.query(
        `SELECT pg_advisory_unlock_shared(hashtextextended('data-access-mutation:global', 0))`
      )
      await expect(check).resolves.toBeDefined()
    } finally {
      await mutationClient.query(
        `SELECT pg_advisory_unlock_shared(hashtextextended('data-access-mutation:global', 0))`
      ).catch(() => undefined)
      mutationClient.release()
    }

    await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
    await expect(pool.query(buildProjectionRollbackCheckSql(schemaName)))
      .rejects.toThrow(/file rollback gate is not active/)
  })

  it('keeps pre-027 mutations frozen after the safety check until rollback completes', async () => {
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    await pool.query(buildProjectionRollbackCheckSql(schemaName))

    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    let ready = false
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      try {
        await pool.query(buildProjectionRollbackLockReadySql(schemaName))
        ready = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    expect(ready).toBe(true)

    const oldApiProbe = await pool.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock_shared(
         hashtextextended('data-access-mutation:global', 0)
       ) AS acquired`
    )
    expect(oldApiProbe.rows[0]?.acquired).toBe(false)

    await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
    await holder
    await expect(pool.query(buildProjectionRollbackLockReleaseWaitSql(schemaName)))
      .resolves.toBeDefined()
  })

  it('detects a holder backend terminated after readiness', async () => {
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    const holderSettled = holder.then(() => undefined, () => undefined)
    try {
      let pid: number | undefined
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await pool.query<{ pid: number }>(
          `SELECT activity.pid FROM pg_stat_activity AS activity
           JOIN pg_locks AS held ON held.pid = activity.pid
           WHERE activity.application_name = $1 AND held.locktype = 'advisory'
             AND held.mode = 'ExclusiveLock' AND held.granted`,
          [`druvia-holder:${schemaName}`]
        )
        pid = result.rows[0]?.pid
        if (pid) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(pid).toBeDefined()
      const beforeTermination = await pool.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_stat_activity AS activity
         JOIN pg_locks AS held ON held.pid = activity.pid
         WHERE activity.application_name = $1 AND held.locktype = 'advisory'
           AND held.mode = 'ExclusiveLock' AND held.granted`,
        [`druvia-holder:${schemaName}`]
      )
      expect(beforeTermination.rows).toEqual([{ pid }])
      await expect(pool.query(buildProjectionRollbackLockReadySql(schemaName))).resolves.toBeDefined()
      const terminated = await pool.query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1, 5000) AS terminated', [pid]
      )
      expect(terminated.rows[0]?.terminated).toBe(true)
      await holderSettled
      const gate = await pool.query<{ active: boolean }>(
        `SELECT active FROM "${schemaName}".druvia_data_access_runtime_gates
         WHERE gate_name = 'file_rollback'`
      )
      expect(gate.rows[0]?.active).toBe(true)
      const stillHolding = await pool.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_stat_activity AS activity
         JOIN pg_locks AS held ON held.pid = activity.pid
         WHERE activity.application_name = $1 AND held.locktype = 'advisory'
           AND held.mode = 'ExclusiveLock' AND held.granted`,
        [`druvia-holder:${schemaName}`]
      )
      expect(stillHolding.rows).toEqual([])
      const releaseProbe = await pool.connect()
      try {
        const result = await releaseProbe.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock_shared(hashtextextended('data-access-mutation:global', 0)) AS acquired`
        )
        expect(result.rows[0]?.acquired).toBe(true)
        await releaseProbe.query(
          `SELECT pg_advisory_unlock_shared(hashtextextended('data-access-mutation:global', 0))`
        )
      } finally {
        releaseProbe.release()
      }
      await expect(pool.query(buildProjectionRollbackLockReadySql(schemaName)))
        .rejects.toThrow(/holder is not ready/)
    } finally {
      await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
      await holderSettled
    }
  })

  it('does not clear the gate when the holder disappears immediately before teardown', async () => {
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    const settled = holder.then(() => undefined, () => undefined)
    try {
      let pid: number | undefined
      for (let attempt = 0; attempt < 30 && !pid; attempt += 1) {
        const result = await pool.query<{ pid: number }>(
          `SELECT activity.pid FROM pg_stat_activity AS activity
           JOIN pg_locks AS held ON held.pid = activity.pid
           WHERE activity.application_name = $1 AND held.locktype = 'advisory'
             AND held.mode = 'ExclusiveLock' AND held.granted`,
          [`druvia-holder:${schemaName}`]
        )
        pid = result.rows[0]?.pid
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(pid).toBeDefined()
      await pool.query('SELECT pg_terminate_backend($1, 5000)', [pid])
      await settled
      await expect(pool.query(buildProjectionRollbackGateSql('disable', schemaName, true)))
        .rejects.toThrow(/holder is not ready/)
      const gate = await pool.query<{ active: boolean }>(
        `SELECT active FROM "${schemaName}".druvia_data_access_runtime_gates
         WHERE gate_name = 'file_rollback'`
      )
      expect(gate.rows[0]?.active).toBe(true)
    } finally {
      await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
      await settled
    }
  })

  it('retires a stale rollback holder without dropping an already active gate', async () => {
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    const holderSettled = holder.then(() => undefined, () => undefined)
    try {
      let ready = false
      for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
        try {
          await pool.query(buildProjectionRollbackLockReadySql(schemaName))
          ready = true
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      expect(ready).toBe(true)

      await pool.query(buildProjectionRollbackLockReleaseWaitSql(schemaName, false, true))
      await holderSettled
      const gate = await pool.query<{ active: boolean }>(
        `SELECT active FROM "${schemaName}".druvia_data_access_runtime_gates
         WHERE gate_name = 'file_rollback'`
      )
      expect(gate.rows[0]?.active).toBe(true)
      await expect(pool.query(buildProjectionRollbackLockReadySql(schemaName)))
        .rejects.toThrow(/holder is not ready/)
    } finally {
      await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
      await holderSettled
    }
  })

  it('rejects migration down promptly when the rollback holder is active', async () => {
    await pool.query(buildProjectionRollbackGateSql('enable', schemaName))
    const holder = pool.query(buildProjectionRollbackLockHolderSql(schemaName))
    try {
      let ready = false
      for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
        try {
          await pool.query(buildProjectionRollbackLockReadySql(schemaName))
          ready = true
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      expect(ready).toBe(true)
      const sql = await readFile('migrations/027_data_access_authorization_projections.down.sql', 'utf8')
      const prefix = sql.slice(0, sql.indexOf('DROP TRIGGER'))
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO "${schemaName}", public`)
        await client.query('SET statement_timeout = 1500')
        await expect(client.query(prefix)).rejects.toMatchObject({ code: '55006' })
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    } finally {
      await pool.query(buildProjectionRollbackGateSql('disable', schemaName))
      await holder.catch(() => undefined)
    }
  })
})
