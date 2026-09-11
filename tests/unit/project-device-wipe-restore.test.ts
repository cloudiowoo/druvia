import { beforeEach, describe, expect, it, vi } from 'vitest'

const { inspectHooks, registerHook, acknowledgeHook, decryptSecretMock } = vi.hoisted(() => ({
  inspectHooks: vi.fn(),
  registerHook: vi.fn(),
  acknowledgeHook: vi.fn(),
  decryptSecretMock: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project-auth/project-device-wipe.hooks.js', () => ({
  inspectDeviceWipeHookContracts: inspectHooks,
  registerDeviceWipeBindingHook: registerHook,
  acknowledgeDeviceWipeMandateHook: acknowledgeHook,
}))
vi.mock('../../apps/api/src/lib/secret-encryption.js', () => ({
  decryptSecret: decryptSecretMock,
}))

import {
  ProjectDeviceWipeRestoreError,
  replayProjectDeviceWipeRegistrations,
  replayProjectDeviceWipeReceipts,
} from '../../apps/api/src/modules/project-auth/project-device-wipe-restore.service.js'

const hashes = {
  register: 'a'.repeat(64),
  query: 'b'.repeat(64),
  acknowledge: 'c'.repeat(64),
}

function restoredRow(overrides: Record<string, unknown> = {}) {
  return {
    binding_id: '00000000-0000-4000-8000-000000000601',
    project_user_id_encrypted: 'encrypted-project-user-1',
    project_schema: 'dru_default_pitchetch',
    register_function: 'druvia_register_device_wipe_binding',
    register_contract_hash: hashes.register,
    query_function: 'druvia_list_device_wipe_mandates',
    query_contract_hash: hashes.query,
    acknowledge_function: 'druvia_ack_device_wipe_mandate',
    acknowledge_contract_hash: hashes.acknowledge,
    binding_identity_hmac: 'H'.repeat(43),
    binding_revision: '7',
    deletion_id: '00000000-0000-4000-8000-000000000700',
    receipt_json: {
      version: 1,
      deletionID: { rawValue: '00000000-0000-4000-8000-000000000700' },
      scope: { kind: 'account' },
      bindingIdentityHMAC: 'H'.repeat(43),
      completedAt: '2026-09-10T00:00:00.000Z',
      result: 'erased',
    },
    ...overrides,
  }
}

describe('project device wipe restore replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inspectHooks.mockResolvedValue({
      schemaName: 'dru_default_pitchetch',
      registerFunction: 'druvia_register_device_wipe_binding',
      registerContractHash: hashes.register,
      queryFunction: 'druvia_list_device_wipe_mandates',
      queryContractHash: hashes.query,
      acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
      acknowledgeContractHash: hashes.acknowledge,
    })
    acknowledgeHook.mockResolvedValue(undefined)
    registerHook.mockResolvedValue(undefined)
    decryptSecretMock.mockReturnValue('project-user-1')
  })

  it('replays restored binding registrations before acknowledged receipts', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [restoredRow()] }) }

    await replayProjectDeviceWipeRegistrations(client as never, 'proj_1')
    await replayProjectDeviceWipeReceipts(client as never, 'proj_1')

    expect(inspectHooks).toHaveBeenCalledWith(client, 'proj_1', {
      registerFunction: 'druvia_register_device_wipe_binding',
      queryFunction: 'druvia_list_device_wipe_mandates',
      acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
    })
    expect(acknowledgeHook).toHaveBeenCalledWith(client, expect.objectContaining({
      contractHash: hashes.acknowledge,
      bindingIdentityHmac: 'H'.repeat(43),
      bindingRevision: 7,
      deletionId: '00000000-0000-4000-8000-000000000700',
    }))
    expect(registerHook).toHaveBeenCalledWith(client, expect.objectContaining({
      projectUserId: 'project-user-1',
      bindingIdentityHmac: 'H'.repeat(43),
      bindingRevision: 7,
    }))
    expect(registerHook.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeHook.mock.invocationCallOrder[0]!,
    )
  })

  it('requests binding revisions in deterministic identity and revision order', async () => {
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        expect(sql).toContain(
          'ORDER BY binding_identity_hmac, binding_revision, binding_id',
        )
        return {
          rows: [
            restoredRow({
              binding_id: '00000000-0000-4000-8000-000000000602',
              binding_revision: '7',
            }),
            restoredRow({
              binding_id: '00000000-0000-4000-8000-000000000603',
              binding_revision: '8',
            }),
          ],
        }
      }),
    }

    await replayProjectDeviceWipeRegistrations(client as never, 'proj_1')

    expect(registerHook.mock.calls.map((call) => call[1].bindingRevision)).toEqual([7, 8])
  })

  it('fails closed before replay when a restored Hook contract differs from the binding snapshot', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [restoredRow()] }) }
    inspectHooks.mockResolvedValueOnce({
      schemaName: 'dru_default_pitchetch',
      registerFunction: 'druvia_register_device_wipe_binding',
      registerContractHash: 'd'.repeat(64),
      queryFunction: 'druvia_list_device_wipe_mandates',
      queryContractHash: hashes.query,
      acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
      acknowledgeContractHash: hashes.acknowledge,
    })

    await expect(replayProjectDeviceWipeReceipts(client as never, 'proj_1')).rejects.toBeInstanceOf(
      ProjectDeviceWipeRestoreError,
    )
    expect(acknowledgeHook).not.toHaveBeenCalled()
  })

  it('validates bindings without acknowledged receipts and performs no replay', async () => {
    const client = { query: vi.fn().mockResolvedValue({
      rows: [restoredRow({ deletion_id: null, receipt_json: null })],
    }) }

    await replayProjectDeviceWipeReceipts(client as never, 'proj_1')

    expect(inspectHooks).toHaveBeenCalledTimes(1)
    expect(acknowledgeHook).not.toHaveBeenCalled()
  })

  it('fails closed when registration replay material cannot be decrypted', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [restoredRow()] }) }
    decryptSecretMock.mockImplementationOnce(() => {
      throw new Error('cannot decrypt')
    })

    await expect(replayProjectDeviceWipeRegistrations(client as never, 'proj_1'))
      .rejects.toMatchObject({ code: 'DEVICE_WIPE_BINDING_REPLAY_REQUIRED' })
    expect(registerHook).not.toHaveBeenCalled()
  })
})
