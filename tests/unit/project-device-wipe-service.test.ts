import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  clientQuery,
  inspectHooks,
  registerHook,
  listHook,
  acknowledgeHook,
  projectLock,
  encryptSecretMock,
  loggerInfo,
} = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  inspectHooks: vi.fn(),
  registerHook: vi.fn(),
  listHook: vi.fn(),
  acknowledgeHook: vi.fn(),
  projectLock: vi.fn(),
  encryptSecretMock: vi.fn((value: string) => `encrypted:${value}`),
  loggerInfo: vi.fn(),
}))

vi.mock('../../apps/api/src/config/index.js', () => ({
  config: {
    deviceWipe: {
      bindingSecret: 'b'.repeat(64),
      credentialSecret: 'c'.repeat(64),
      protectedSecrets: [],
      hookStatementTimeoutMs: 5000,
      restoreHookStatementTimeoutMs: 30000,
    },
  },
}))
vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
  },
}))
vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  acquireProjectAuthProjectLock: projectLock,
}))
vi.mock('../../apps/api/src/modules/project-auth/project-device-wipe.hooks.js', () => ({
  inspectDeviceWipeHookContracts: inspectHooks,
  registerDeviceWipeBindingHook: registerHook,
  listDeviceWipeMandatesHook: listHook,
  acknowledgeDeviceWipeMandateHook: acknowledgeHook,
}))
vi.mock('../../apps/api/src/lib/secret-encryption.js', () => ({
  encryptSecret: encryptSecretMock,
  decryptSecret: vi.fn((value: string) => value.replace(/^encrypted:/, '')),
}))
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  })),
}))

import {
  acknowledgeProjectDeviceWipeMandate,
  assertProjectDeviceWipeProjectDeletionAllowed,
  normalizeDeviceWipeReceipt,
  queryProjectDeviceWipeMandates,
  registerProjectDeviceWipeBinding,
  updateProjectDeviceWipeConfig,
} from '../../apps/api/src/modules/project-auth/project-device-wipe.service.js'
import {
  canonicalDeviceWipeJson,
  deriveDeviceWipeSecretVerification,
  deriveProjectUserFingerprint,
} from '../../apps/api/src/modules/project-auth/project-device-wipe.crypto.js'
import { config } from '../../apps/api/src/config/index.js'

const contracts = {
  schemaName: 'dru_default_pitchetch',
  registerFunction: 'druvia_register_device_wipe_binding',
  registerContractHash: 'a'.repeat(64),
  queryFunction: 'druvia_list_device_wipe_mandates',
  queryContractHash: 'b'.repeat(64),
  acknowledgeFunction: 'druvia_ack_device_wipe_mandate',
  acknowledgeContractHash: 'c'.repeat(64),
}

const bindingRow = {
  binding_id: '00000000-0000-4000-8000-000000000601',
  project_id: 'proj_1',
  project_user_fingerprint: 'mGGuQo29PUb5SBeP3kK3Wq2Fjsq0Ygq99vw7omUP-oY',
  binding_identity_hmac: 'WOd2gVCckIZoOZp9vQXXiB4hdK0I5LGfY4rVQbrND9I',
  binding_revision: '7',
  binding_handle: 'dwb_12345678901234567890123456789012',
  lookup_token_hash: 'f'.repeat(64),
  status: 'active',
  project_schema: contracts.schemaName,
  register_function: contracts.registerFunction,
  register_contract_hash: contracts.registerContractHash,
  query_function: contracts.queryFunction,
  query_contract_hash: contracts.queryContractHash,
  acknowledge_function: contracts.acknowledgeFunction,
  acknowledge_contract_hash: contracts.acknowledgeContractHash,
  idempotency_key: '00000000-0000-4000-8000-000000000602',
}

const secretVerification = {
  binding_secret_verification: deriveDeviceWipeSecretVerification('b'.repeat(64), 'binding'),
  credential_secret_verification: deriveDeviceWipeSecretVerification('c'.repeat(64), 'credential'),
}

describe('project device wipe service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inspectHooks.mockResolvedValue(contracts)
    registerHook.mockResolvedValue(undefined)
    acknowledgeHook.mockResolvedValue(undefined)
    projectLock.mockResolvedValue(undefined)
    encryptSecretMock.mockImplementation((value: string) => `encrypted:${value}`)
  })

  it('sets a bounded transaction-local timeout before project Hook work', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          ...secretVerification,
        }] }
      }
      if (sql.includes('idempotency_key') || sql.includes('binding_identity_hmac')) return { rows: [] }
      return { rows: [] }
    })

    await registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })

    expect(clientQuery).toHaveBeenCalledWith(
      "SELECT set_config('statement_timeout', $1, true)",
      ['5000ms'],
    )
    expect(clientQuery.mock.invocationCallOrder.find((_order, index) => (
      clientQuery.mock.calls[index]?.[0] === "SELECT set_config('statement_timeout', $1, true)"
    ))).toBeLessThan(registerHook.mock.invocationCallOrder[0])
  })

  it('maps PostgreSQL statement timeout to a retryable device wipe error', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT set_config('statement_timeout', $1, true)") return { rows: [] }
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          ...secretVerification,
        }] }
      }
      if (sql.includes('idempotency_key') || sql.includes('binding_identity_hmac')) return { rows: [] }
      return { rows: [] }
    })
    registerHook.mockRejectedValueOnce(new Error('wrapped Hook error', {
      cause: Object.assign(new Error('statement timeout'), { code: '57014' }),
    }))

    await expect(registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })).rejects.toMatchObject({
      code: 'DEVICE_WIPE_HOOK_TIMEOUT',
      statusCode: 503,
    })
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK')
  })

  it('maps a project-lock statement timeout to the same retryable error', async () => {
    projectLock.mockRejectedValueOnce(Object.assign(new Error('lock wait timeout'), { code: '57014' }))

    await expect(updateProjectDeviceWipeConfig('proj_1', false)).rejects.toMatchObject({
      code: 'DEVICE_WIPE_HOOK_TIMEOUT',
      statusCode: 503,
    })
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK')
  })

  it.each([
    { deletionID: { rawValue: '00000000-0000-4000-8000-000000000700', extra: 'smuggled' } },
    { scope: { kind: 'account', extra: 'smuggled' } },
  ])('rejects extra nested receipt fields', (override) => {
    const receipt = {
      version: 1,
      deletionID: { rawValue: '00000000-0000-4000-8000-000000000700' },
      scope: { kind: 'account' },
      bindingIdentityHMAC: bindingRow.binding_identity_hmac,
      completedAt: '2026-09-10T00:00:00.000Z',
      result: 'erased',
      ...override,
    }

    expect(() => normalizeDeviceWipeReceipt(receipt, {
      deletionId: '00000000-0000-4000-8000-000000000700',
      bindingIdentityHmac: bindingRow.binding_identity_hmac,
      scope: 'account',
      sessionId: null,
    })).toThrowError(expect.objectContaining({ code: 'DEVICE_WIPE_RECEIPT_INVALID' }))
  })

  it('rejects extra fields in a session receipt ID wrapper', () => {
    const sessionId = '00000000-0000-4000-8000-000000000701'
    const receipt = {
      version: 1,
      deletionID: { rawValue: '00000000-0000-4000-8000-000000000700' },
      scope: { kind: 'session', sessionID: { rawValue: sessionId, extra: 'smuggled' } },
      bindingIdentityHMAC: bindingRow.binding_identity_hmac,
      completedAt: '2026-09-10T00:00:00.000Z',
      result: 'erased',
    }

    expect(() => normalizeDeviceWipeReceipt(receipt, {
      deletionId: '00000000-0000-4000-8000-000000000700',
      bindingIdentityHmac: bindingRow.binding_identity_hmac,
      scope: 'session',
      sessionId,
    })).toThrowError(expect.objectContaining({ code: 'DEVICE_WIPE_RECEIPT_INVALID' }))
  })

  it('maps signing-key encryption failures to a safe service error', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) return { rows: [] }
      if (sql.includes('INSERT INTO druvia_project_device_wipe_configs')) return { rows: [] }
      if (sql.includes('FROM druvia_project_device_wipe_signing_keys')) return { rows: [] }
      return { rows: [] }
    })
    encryptSecretMock.mockImplementationOnce(() => {
      throw new Error('SECRETS_ENCRYPTION_KEY is missing')
    })

    await expect(updateProjectDeviceWipeConfig('proj_1', true)).rejects.toMatchObject({
      code: 'DEVICE_WIPE_UNAVAILABLE',
      statusCode: 503,
      message: 'Project device wipe signing key cannot be stored',
    })
  })

  it('maps missing feature secrets to a safe service error', async () => {
    const original = config.deviceWipe.bindingSecret
    config.deviceWipe.bindingSecret = ''
    try {
      await expect(updateProjectDeviceWipeConfig('proj_1', true)).rejects.toMatchObject({
        code: 'DEVICE_WIPE_UNAVAILABLE',
        statusCode: 503,
        message: 'Project device wipe secrets are unavailable',
      })
    } finally {
      config.deviceWipe.bindingSecret = original
    }
  })

  it('fails closed when persisted device wipe secret verification changes', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          binding_secret_verification: 'Z'.repeat(43),
          credential_secret_verification: secretVerification.credential_secret_verification,
        }] }
      }
      return { rows: [] }
    })

    await expect(registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_SECRET_MISMATCH', statusCode: 503 })
  })

  it('blocks project deletion before destructive cleanup when device wipe state exists', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ blocked: true }] })

    await expect(assertProjectDeviceWipeProjectDeletionAllowed('proj_1')).rejects.toMatchObject({
      code: 'DEVICE_WIPE_DECOMMISSION_REQUIRED',
      statusCode: 409,
    })
  })

  it('registers only the authenticated Project User and returns a separate lookup credential', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          ...secretVerification,
        }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_bindings') && sql.includes('idempotency_key')) {
        return { rows: [] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_bindings') && sql.includes('binding_identity_hmac')) {
        return { rows: [] }
      }
      if (sql.includes('INSERT INTO druvia_project_device_wipe_bindings')) return { rows: [] }
      return { rows: [] }
    })

    const result = await registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })

    expect(registerHook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      projectUserId: '00000000-0000-4000-8000-000000000001',
      bindingRevision: 7,
      bindingIdentityHmac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    }))
    expect(result).toMatchObject({
      bindingHandle: expect.stringMatching(/^dwb_/),
      bindingLookupToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      bindingRevision: 7,
    })
    expect(result.bindingHandle).not.toContain(result.bindingLookupToken)
    expect(encryptSecretMock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      { requireDedicatedKey: true },
    )
    const insert = clientQuery.mock.calls.find(([sql]) => (
      typeof sql === 'string' && sql.includes('INSERT INTO druvia_project_device_wipe_bindings')
    ))
    expect(insert?.[1]).toContain('encrypted:00000000-0000-4000-8000-000000000001')
    expect(loggerInfo).toHaveBeenCalledWith(
      'project device wipe binding registered',
      expect.objectContaining({
        projectUserId: undefined,
        projectUserFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
    )
  })

  it('rejects a binding identity already owned by another Project User', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          ...secretVerification,
        }] }
      }
      if (sql.includes('idempotency_key')) return { rows: [] }
      if (sql.includes('binding_identity_hmac')) {
        return { rows: [{ ...bindingRow, project_user_fingerprint: 'Z'.repeat(43) }] }
      }
      return { rows: [] }
    })

    await expect(registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_BINDING_CONFLICT', statusCode: 409 })

    expect(registerHook).not.toHaveBeenCalled()
  })

  it('does not recover a retired credential through a new idempotency key', async () => {
    const projectUserFingerprint = deriveProjectUserFingerprint({
      secret: 'b'.repeat(64),
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
    })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_configs')) {
        return { rows: [{
          enabled: true,
          register_function: contracts.registerFunction,
          query_function: contracts.queryFunction,
          acknowledge_function: contracts.acknowledgeFunction,
          ...secretVerification,
        }] }
      }
      if (sql.includes('idempotency_key')) return { rows: [] }
      if (sql.includes('binding_identity_hmac')) {
        return { rows: [
          { ...bindingRow, project_user_fingerprint: projectUserFingerprint, binding_revision: '8', status: 'active' },
          { ...bindingRow, project_user_fingerprint: projectUserFingerprint, binding_revision: '7', status: 'retired' },
        ] }
      }
      return { rows: [] }
    })

    await expect(registerProjectDeviceWipeBinding({
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000699',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_BINDING_REVISION_STALE', statusCode: 409 })
  })

  it('returns a stable signed mandate after the Project Session is no longer involved', async () => {
    const lookupToken = 'L'.repeat(43)
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(lookupToken).digest('hex')
    const activePrivateJwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
    }
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_bindings') && sql.includes('binding_handle')) {
        return { rows: [{ ...bindingRow, lookup_token_hash: tokenHash }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_mandates')) return { rows: [] }
      if (sql.includes('FROM druvia_project_device_wipe_signing_keys') && sql.includes("status = 'active'")) {
        return { rows: [{
          key_id: 'global-watch-ed25519-v1',
          public_jwk: { kty: 'OKP', crv: 'Ed25519', x: activePrivateJwk.x },
          private_jwk_encrypted: `encrypted:${JSON.stringify(activePrivateJwk)}`,
        }] }
      }
      if (sql.includes('INSERT INTO druvia_project_device_wipe_mandates')) return { rows: [] }
      return { rows: [] }
    })
    listHook.mockResolvedValueOnce([{
      deletionId: '00000000-0000-4000-8000-000000000700',
      scope: 'account',
      sessionId: null,
    }])

    const result = await queryProjectDeviceWipeMandates({
      projectId: 'proj_1',
      bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken,
    })

    expect(result.mandates).toHaveLength(1)
    expect(result.mandates[0]).toMatchObject({
      version: 1,
      keyID: 'global-watch-ed25519-v1',
      command: {
        projectID: 'proj_1',
        bindingIdentityHMAC: bindingRow.binding_identity_hmac,
        scope: { kind: 'account' },
      },
      signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
    })
    expect(listHook).toHaveBeenCalled()
    expect(projectLock).toHaveBeenCalledWith(expect.anything(), 'proj_1')
    const bindingReadIndex = clientQuery.mock.calls.findIndex(([sql]) => (
      typeof sql === 'string' && sql.includes('binding_handle')
    ))
    expect(projectLock.mock.invocationCallOrder[0]).toBeLessThan(
      clientQuery.mock.invocationCallOrder[bindingReadIndex]!,
    )
  })

  it('suppresses an acknowledged mandate restored by the project database', async () => {
    const lookupToken = 'L'.repeat(43)
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(lookupToken).digest('hex')
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_bindings')) {
        return { rows: [{ ...bindingRow, lookup_token_hash: tokenHash }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_mandates')) {
        return { rows: [{
          deletion_id: '00000000-0000-4000-8000-000000000700',
          scope: 'account',
          session_id: null,
          key_id: 'global-watch-ed25519-v1',
          command_json: { version: 1 },
          signature: 'S'.repeat(86),
          status: 'acknowledged',
          receipt_digest: 'd'.repeat(64),
          receipt_json: { version: 1 },
          acknowledged_at: new Date(),
        }] }
      }
      return { rows: [] }
    })
    listHook.mockResolvedValueOnce([{
      deletionId: '00000000-0000-4000-8000-000000000700',
      scope: 'account',
      sessionId: null,
    }])

    await expect(queryProjectDeviceWipeMandates({
      projectId: 'proj_1',
      bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken,
    })).resolves.toEqual({ mandates: [] })
  })

  it('returns the original signed snapshot without re-signing an existing mandate', async () => {
    const lookupToken = 'L'.repeat(43)
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(lookupToken).digest('hex')
    const command = {
      version: 1,
      deletionID: { rawValue: '00000000-0000-4000-8000-000000000700' },
      projectID: 'proj_1',
      projectUserFingerprint: bindingRow.project_user_fingerprint,
      bindingIdentityHMAC: bindingRow.binding_identity_hmac,
      bindingRevision: 7,
      scope: { kind: 'session', sessionID: { rawValue: '00000000-0000-4000-8000-000000000701' } },
    }
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_bindings')) {
        return { rows: [{ ...bindingRow, lookup_token_hash: tokenHash }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_mandates')) {
        return { rows: [{
          deletion_id: command.deletionID.rawValue,
          scope: 'session',
          session_id: command.scope.sessionID.rawValue,
          key_id: 'global-watch-ed25519-v1',
          command_json: command,
          signature: 'S'.repeat(86),
          status: 'pending',
          receipt_digest: null,
          receipt_json: null,
          acknowledged_at: null,
        }] }
      }
      return { rows: [] }
    })
    listHook.mockResolvedValueOnce([{
      deletionId: command.deletionID.rawValue,
      scope: 'session',
      sessionId: command.scope.sessionID.rawValue,
    }])

    await expect(queryProjectDeviceWipeMandates({
      projectId: 'proj_1',
      bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken,
    })).resolves.toEqual({
      mandates: [{
        version: 1,
        keyID: 'global-watch-ed25519-v1',
        command,
        signature: 'S'.repeat(86),
      }],
    })
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO druvia_project_device_wipe_mandates'),
      expect.anything(),
    )
    expect(listHook).not.toHaveBeenCalled()
  })

  it('does not discover new mandates for a retired binding', async () => {
    const lookupToken = 'L'.repeat(43)
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(lookupToken).digest('hex')
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_bindings')) {
        return { rows: [{ ...bindingRow, status: 'retired', lookup_token_hash: tokenHash }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_mandates')) return { rows: [] }
      return { rows: [] }
    })

    await expect(queryProjectDeviceWipeMandates({
      projectId: 'proj_1',
      bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken,
    })).resolves.toEqual({ mandates: [] })
    expect(listHook).not.toHaveBeenCalled()
  })

  it.each(['restoring', 'recovery_required']) (
    'blocks registration, query and receipt while the project runtime gate is %s',
    async (status) => {
      clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM druvia_project_runtime_gates')) return { rows: [{ status }] }
        return { rows: [] }
      })

      await expect(registerProjectDeviceWipeBinding({
        projectId: 'proj_1',
        projectUserId: 'project-user-1',
        idempotencyKey: '00000000-0000-4000-8000-000000000602',
        bindingIdentity: 'A'.repeat(32),
        bindingRevision: 7,
      })).rejects.toMatchObject({ code: 'PROJECT_RESTORE_IN_PROGRESS', statusCode: 503 })
      await expect(queryProjectDeviceWipeMandates({
        projectId: 'proj_1',
        bindingHandle: bindingRow.binding_handle,
        bindingLookupToken: 'L'.repeat(43),
      })).rejects.toMatchObject({ code: 'PROJECT_RESTORE_IN_PROGRESS', statusCode: 503 })
      await expect(acknowledgeProjectDeviceWipeMandate({
        projectId: 'proj_1',
        bindingHandle: bindingRow.binding_handle,
        bindingLookupToken: 'L'.repeat(43),
        deletionId: '00000000-0000-4000-8000-000000000700',
        receipt: {},
      })).rejects.toMatchObject({ code: 'PROJECT_RESTORE_IN_PROGRESS', statusCode: 503 })

      expect(inspectHooks).not.toHaveBeenCalled()
      expect(registerHook).not.toHaveBeenCalled()
      expect(listHook).not.toHaveBeenCalled()
      expect(acknowledgeHook).not.toHaveBeenCalled()
      expect(clientQuery.mock.calls.some(([sql]) => (
        typeof sql === 'string'
        && (sql.includes('binding_handle') || sql.includes('INSERT INTO druvia_project_device_wipe_mandates'))
      ))).toBe(false)
    },
  )

  it('accepts an identical receipt replay and rejects a conflicting replay', async () => {
    const lookupToken = 'L'.repeat(43)
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(lookupToken).digest('hex')
    const receipt = {
      version: 1,
      deletionID: { rawValue: '00000000-0000-4000-8000-000000000700' },
      scope: { kind: 'account' },
      bindingIdentityHMAC: bindingRow.binding_identity_hmac,
      completedAt: '2026-09-10T00:00:00.000Z',
      result: 'erased',
    }

    let storedReceipt = receipt
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_device_wipe_bindings')) {
        return { rows: [{ ...bindingRow, lookup_token_hash: tokenHash }] }
      }
      if (sql.includes('FROM druvia_project_device_wipe_mandates')) {
        return { rows: [{
          deletion_id: receipt.deletionID.rawValue,
          scope: 'account',
          session_id: null,
          key_id: 'global-watch-ed25519-v1',
          command_json: {
            bindingIdentityHMAC: bindingRow.binding_identity_hmac,
            scope: { kind: 'account' },
          },
          signature: 'S'.repeat(86),
          status: 'acknowledged',
          receipt_json: storedReceipt,
          receipt_digest: (await import('node:crypto')).createHash('sha256')
            .update(canonicalDeviceWipeJson(storedReceipt)).digest('hex'),
          acknowledged_at: new Date('2026-09-10T00:01:00.000Z'),
        }] }
      }
      return { rows: [] }
    })

    await expect(acknowledgeProjectDeviceWipeMandate({
      projectId: 'proj_1', bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken, deletionId: receipt.deletionID.rawValue, receipt,
    })).resolves.toMatchObject({ acknowledged: true, replay: true })
    expect(projectLock).toHaveBeenCalledWith(expect.anything(), 'proj_1')
    const bindingReadIndex = clientQuery.mock.calls.findIndex(([sql]) => (
      typeof sql === 'string' && sql.includes('binding_handle')
    ))
    expect(projectLock.mock.invocationCallOrder[0]).toBeLessThan(
      clientQuery.mock.invocationCallOrder[bindingReadIndex]!,
    )
    expect(acknowledgeHook).not.toHaveBeenCalled()

    storedReceipt = { ...receipt, completedAt: '2026-09-10T00:02:00.000Z' }
    await expect(acknowledgeProjectDeviceWipeMandate({
      projectId: 'proj_1', bindingHandle: bindingRow.binding_handle,
      bindingLookupToken: lookupToken, deletionId: receipt.deletionID.rawValue, receipt,
    })).rejects.toMatchObject({ code: 'DEVICE_WIPE_RECEIPT_CONFLICT', statusCode: 409 })
  })
})
