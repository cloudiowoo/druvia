import { describe, expect, it, vi } from 'vitest'
import {
  acknowledgeDeviceWipeMandateHook,
  inspectDeviceWipeHookContracts,
  listDeviceWipeMandatesHook,
  registerDeviceWipeBindingHook,
} from '../../apps/api/src/modules/project-auth/project-device-wipe.hooks.js'

const names = {
  registerFunction: 'druvia_register_device_wipe_binding',
  queryFunction: 'druvia_list_device_wipe_mandates',
  acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
}

const validContract = {
  owner_name: 'dru_default_pitchetch_user',
  owner_superuser: false,
  owner_bypassrls: false,
  owner_createrole: false,
  owner_replication: false,
  security_definer: true,
  function_config: ['search_path=pg_catalog, dru_default_pitchetch, pg_temp'],
  fixed_search_path: true,
  public_execute: false,
  non_owner_execute: false,
  owner_role_membership: false,
  owner_assumable_by_non_superuser: false,
  owner_cross_schema_relation_access: false,
  owner_cross_schema_column_access: false,
  owner_cross_schema_sequence_access: false,
  owner_cross_schema_create: false,
  owner_cross_schema_definer_execute: false,
  contract_hash: 'a'.repeat(64),
}

function inspectionClient(override: Record<string, unknown> = {}) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({
        rows: [{ schema_name: 'dru_default_pitchetch', db_user: 'dru_default_pitchetch_user' }],
      })
      .mockResolvedValueOnce({ rows: [{ ...validContract, ...override }] })
      .mockResolvedValueOnce({ rows: [{ ...validContract, contract_hash: 'b'.repeat(64), ...override }] })
      .mockResolvedValueOnce({ rows: [{ ...validContract, contract_hash: 'c'.repeat(64), ...override }] }),
  }
}

describe('project device wipe Hook contracts', () => {
  it('accepts the three exact unprivileged security contracts', async () => {
    const client = inspectionClient()

    await expect(inspectDeviceWipeHookContracts(client as never, 'proj_1', names)).resolves.toEqual({
      schemaName: 'dru_default_pitchetch',
      registerFunction: names.registerFunction,
      registerContractHash: 'a'.repeat(64),
      queryFunction: names.queryFunction,
      queryContractHash: 'b'.repeat(64),
      acknowledgeFunction: names.acknowledgeFunction,
      acknowledgeContractHash: 'c'.repeat(64),
    })

    expect(client.query.mock.calls[1]?.[0]).toMatch(/text,text,bigint/)
    expect(client.query.mock.calls[2]?.[0]).toMatch(/text,bigint/)
    expect(client.query.mock.calls[3]?.[0]).toMatch(/text,bigint,uuid,jsonb/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/pg_has_role\([\s\S]*'MEMBER'/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/candidate_role\.oid[\s\S]*owner_role\.oid[\s\S]*'MEMBER'/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/has_table_privilege\([\s\S]*SELECT,INSERT,UPDATE,DELETE/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/has_any_column_privilege\([\s\S]*SELECT,INSERT,UPDATE,REFERENCES/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/has_sequence_privilege\([\s\S]*USAGE,SELECT,UPDATE/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/has_schema_privilege\([\s\S]*'CREATE'/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(/other_proc\.prosecdef[\s\S]*has_function_privilege/)
    expect(client.query.mock.calls[1]?.[0]).toMatch(
      /other_proc\.prorettype NOT IN \('trigger'::regtype, 'event_trigger'::regtype\)/,
    )
    expect(client.query.mock.calls[1]?.[0]).toMatch(/pg_extension/)
  })

  it('guards sequence privilege checks from PostgreSQL predicate reordering', async () => {
    const client = inspectionClient()

    await inspectDeviceWipeHookContracts(client as never, 'proj_1', names)

    const contractSql = client.query.mock.calls[1]?.[0] as string
    const guardedSequenceChecks = contractSql.match(
      /CASE\s+WHEN other_sequence\.relkind = 'S'\s+THEN has_sequence_privilege\([\s\S]*?\)\s+ELSE false\s+END/g,
    )

    expect(guardedSequenceChecks).toHaveLength(2)
  })

  it.each([
    ['superuser owner', { owner_superuser: true }],
    ['non security-definer function', { security_definer: false }],
    ['public execute', { public_execute: true }],
    ['non-owner execute', { non_owner_execute: true }],
    ['role membership', { owner_role_membership: true }],
    ['non-superuser role that can assume owner', { owner_assumable_by_non_superuser: true }],
    ['replication owner', { owner_replication: true }],
    ['cross-schema relation access', { owner_cross_schema_relation_access: true }],
    ['cross-schema column access', { owner_cross_schema_column_access: true }],
    ['cross-schema sequence access', { owner_cross_schema_sequence_access: true }],
    ['cross-schema create', { owner_cross_schema_create: true }],
    ['cross-schema security-definer execute', { owner_cross_schema_definer_execute: true }],
    ['database-normalized search path mismatch', { fixed_search_path: false }],
    ['missing pg_temp search path', { function_config: ['search_path=pg_catalog, dru_default_pitchetch'] }],
    ['pg_temp before trusted schemas', { function_config: ['search_path=pg_temp, pg_catalog, dru_default_pitchetch'] }],
    ['extra public schema in search path', { function_config: ['search_path=pg_catalog, dru_default_pitchetch, public, pg_temp'] }],
    ['duplicate search path settings', { function_config: [
      'search_path=pg_catalog, dru_default_pitchetch, pg_temp',
      'search_path=public',
    ] }],
    ['mutable search path', { function_config: ['search_path=public'] }],
  ])('rejects %s', async (_label, override) => {
    await expect(inspectDeviceWipeHookContracts(
      inspectionClient(override) as never,
      'proj_1',
      names,
    )).rejects.toMatchObject({ code: 'DEVICE_WIPE_NOT_CONFIGURED', statusCode: 409 })
  })

  it('validates and invokes registration in one statement', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ result: { registered: true } }] }) }

    await expect(registerDeviceWipeBindingHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.registerFunction,
      contractHash: 'a'.repeat(64),
      projectUserId: '00000000-0000-4000-8000-000000000001',
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).resolves.toBeUndefined()

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /WITH contract AS MATERIALIZED[\s\S]*WHERE contract_hash = \$1\s+AND fixed_search_path[\s\S]*druvia_register_device_wipe_binding/,
      ),
      expect.arrayContaining(['a'.repeat(64), '00000000-0000-4000-8000-000000000001', 'A'.repeat(43), 1]),
    )
  })

  it('normalizes account and session mandates while rejecting malformed output', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ result: [
      { deletionId: '00000000-0000-4000-8000-000000000700', scope: 'account', sessionId: null },
      {
        deletionId: '00000000-0000-4000-8000-000000000701',
        scope: 'session',
        sessionId: '00000000-0000-4000-8000-000000000702',
      },
    ] }] }) }

    await expect(listDeviceWipeMandatesHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.queryFunction,
      contractHash: 'b'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).resolves.toHaveLength(2)

    client.query.mockResolvedValueOnce({
      rows: [{ result: [{ deletionId: 'not-a-uuid', scope: 'account' }] }],
    })
    await expect(listDeviceWipeMandatesHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.queryFunction,
      contractHash: 'b'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID', statusCode: 503 })
  })

  it('rejects duplicate deletion IDs returned by the project Hook', async () => {
    const duplicate = {
      deletionId: '00000000-0000-4000-8000-000000000700',
      scope: 'account',
      sessionId: null,
    }
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ result: [duplicate, duplicate] }] }) }

    await expect(listDeviceWipeMandatesHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.queryFunction,
      contractHash: 'b'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID', statusCode: 503 })
  })

  it('requires an explicit acknowledged result from the receipt Hook', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ result: { acknowledged: true } }] }) }
    await expect(acknowledgeDeviceWipeMandateHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.acknowledgeFunction,
      contractHash: 'c'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
      deletionId: '00000000-0000-4000-8000-000000000700',
      receipt: { version: 1 },
    })).resolves.toBeUndefined()

    client.query.mockResolvedValueOnce({ rows: [{ result: { acknowledged: false } }] })
    await expect(acknowledgeDeviceWipeMandateHook(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.acknowledgeFunction,
      contractHash: 'c'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
      deletionId: '00000000-0000-4000-8000-000000000700',
      receipt: { version: 1 },
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID', statusCode: 503 })
  })

  it('rejects extra fields in every Hook response', async () => {
    const registrationClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ result: { registered: true, userId: 'leak' } }] }),
    }
    await expect(registerDeviceWipeBindingHook(registrationClient as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.registerFunction,
      contractHash: 'a'.repeat(64),
      projectUserId: '00000000-0000-4000-8000-000000000001',
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID' })

    const queryClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ result: [{
        deletionId: '00000000-0000-4000-8000-000000000700',
        scope: 'account',
        sessionId: null,
        projectUserId: 'leak',
      }] }] }),
    }
    await expect(listDeviceWipeMandatesHook(queryClient as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.queryFunction,
      contractHash: 'b'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID' })

    const acknowledgeClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ result: { acknowledged: true, receipt: 'leak' } }] }),
    }
    await expect(acknowledgeDeviceWipeMandateHook(acknowledgeClient as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: names.acknowledgeFunction,
      contractHash: 'c'.repeat(64),
      bindingIdentityHmac: 'A'.repeat(43),
      bindingRevision: 1,
      deletionId: '00000000-0000-4000-8000-000000000700',
      receipt: { version: 1 },
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_HOOK_INVALID' })
  })
})
