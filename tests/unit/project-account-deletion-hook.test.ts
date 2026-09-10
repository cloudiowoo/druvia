import { describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project-auth/project-auth.service.js', () => ({
  ProjectAuthError: class ProjectAuthError extends Error {
    constructor(public code: string, message: string, public statusCode: number) {
      super(message)
    }
  },
  getAppleAdapter: vi.fn(),
}))

import {
  executeAccountDeletionCleanupContract,
  inspectAccountDeletionCleanupContract,
} from '../../apps/api/src/modules/project-auth/project-account-deletion.service.js'

function clientWith(contract: Record<string, unknown>) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          schema_name: 'dru_default_pitchetch',
          db_user: 'dru_dru_default_pitchetch_user',
          cleanup_function: 'druvia_delete_project_user_data',
        }],
      })
      .mockResolvedValueOnce({ rows: [contract] }),
  }
}

const validContract = {
  owner_name: 'dru_dru_default_pitchetch_user',
  owner_superuser: false,
  owner_bypassrls: false,
  owner_createrole: false,
  security_definer: true,
  function_config: ['search_path=pg_catalog, drU_default_pitchetch'],
  function_acl: '{dru_dru_default_pitchetch_user=X/dru_dru_default_pitchetch_user}',
  public_execute: false,
  non_owner_execute: false,
  owner_privileged_membership: false,
  owner_cross_schema_write: false,
  function_definition: 'CREATE FUNCTION ...',
  contract_hash: 'a'.repeat(64),
}

describe('project account deletion cleanup contract', () => {
  it('accepts only the fixed database function security contract', async () => {
    const client = clientWith(validContract)

    const result = await inspectAccountDeletionCleanupContract(client as never, 'proj_1')

    expect(result).toMatchObject({
      schemaName: 'dru_default_pitchetch',
      functionName: 'druvia_delete_project_user_data',
      contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringMatching(/to_regprocedure\(format\([\s\S]*\$1::text,[\s\S]*\$2::text/),
      ['dru_default_pitchetch', 'druvia_delete_project_user_data'],
    )
  })

  it.each([
    ['superuser owner', { owner_superuser: true }],
    ['non security-definer function', { security_definer: false }],
    ['public execute', { public_execute: true }],
    ['explicit non-owner execute', { non_owner_execute: true }],
    ['privileged inherited role', { owner_privileged_membership: true }],
    ['cross-schema write access', { owner_cross_schema_write: true }],
    ['mutable search path', { function_config: ['search_path=public'] }],
  ])('rejects %s', async (_label, override) => {
    const client = clientWith({ ...validContract, ...override })
    await expect(inspectAccountDeletionCleanupContract(client as never, 'proj_1'))
      .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_CONFIGURED', statusCode: 409 })
  })

  it('validates the contract and invokes the cleanup function in one statement', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ result: { completed: true } }] }) }

    await executeAccountDeletionCleanupContract(client as never, {
      schemaName: 'dru_default_pitchetch',
      functionName: 'druvia_delete_project_user_data',
      contractHash: 'a'.repeat(64),
      projectUserId: 'user_1',
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
    })

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/WITH contract AS MATERIALIZED[\s\S]*validated AS MATERIALIZED[\s\S]*FROM validated/),
      [
        'user_1',
        '05558e52-357a-485b-920a-0ab441a2ad96',
        'dru_default_pitchetch',
        'druvia_delete_project_user_data',
        'a'.repeat(64),
      ],
    )
  })
})
