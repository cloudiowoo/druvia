import { createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { resolveDeviceWipeConfig } from '../../apps/api/src/config/index.js'
import {
  assertDeviceWipeSecretsConfigured,
  buildDeviceWipeCommand,
  canonicalDeviceWipeSigningPayload,
  deriveBindingHandle,
  deriveBindingIdentityHmac,
  deriveBindingLookupToken,
  deriveDeviceWipeSecretVerification,
  deriveProjectUserFingerprint,
  hashBindingLookupToken,
  signDeviceWipeCommand,
  verifyBindingLookupToken,
  verifyDeviceWipeSignature,
} from '../../apps/api/src/modules/project-auth/project-device-wipe.crypto.js'

const bindingSecret = 'b'.repeat(64)
const credentialSecret = 'c'.repeat(64)
const bindingId = '00000000-0000-4000-8000-000000000601'

describe('project device wipe credentials', () => {
  it('bounds normal and restore Hook timeout configuration', () => {
    expect(resolveDeviceWipeConfig({
      DEVICE_WIPE_HOOK_TIMEOUT_MS: 'invalid',
      DEVICE_WIPE_RESTORE_HOOK_TIMEOUT_MS: 'invalid',
    })).toMatchObject({
      hookStatementTimeoutMs: 5000,
      restoreHookStatementTimeoutMs: 30000,
    })
    expect(resolveDeviceWipeConfig({
      DEVICE_WIPE_HOOK_TIMEOUT_MS: '1',
      DEVICE_WIPE_RESTORE_HOOK_TIMEOUT_MS: '999999',
    })).toMatchObject({
      hookStatementTimeoutMs: 1000,
      restoreHookStatementTimeoutMs: 300000,
    })
  })

  it('derives stable, domain-separated and project-scoped identifiers', () => {
    const user = deriveProjectUserFingerprint({
      secret: bindingSecret,
      projectId: 'proj_1',
      projectUserId: '00000000-0000-4000-8000-000000000001',
    })
    const binding = deriveBindingIdentityHmac({
      secret: bindingSecret,
      projectId: 'proj_1',
      bindingIdentity: 'A'.repeat(32),
    })
    const otherProjectBinding = deriveBindingIdentityHmac({
      secret: bindingSecret,
      projectId: 'proj_2',
      bindingIdentity: 'A'.repeat(32),
    })

    expect(user).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(user).not.toBe(binding)
    expect(binding).not.toBe(otherProjectBinding)
  })

  it('keeps the public handle separate from the possession credential', () => {
    const token = deriveBindingLookupToken({
      secret: credentialSecret,
      projectId: 'proj_1',
      bindingId,
    })
    const handle = deriveBindingHandle({
      secret: credentialSecret,
      projectId: 'proj_1',
      bindingId,
    })
    const digest = hashBindingLookupToken(token)

    expect(handle).toMatch(/^dwb_[A-Za-z0-9_-]{32}$/)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(handle).not.toContain(token)
    expect(verifyBindingLookupToken(token, digest)).toBe(true)
    expect(verifyBindingLookupToken(`${token.slice(0, -1)}x`, digest)).toBe(false)
    expect(verifyBindingLookupToken('short', digest)).toBe(false)
  })

  it('requires dedicated distinct feature secrets before use', () => {
    expect(() => assertDeviceWipeSecretsConfigured(resolveDeviceWipeConfig({}))).toThrow(/not configured/i)
    expect(() => assertDeviceWipeSecretsConfigured(resolveDeviceWipeConfig({
      DEVICE_WIPE_BINDING_SECRET: bindingSecret,
      DEVICE_WIPE_CREDENTIAL_SECRET: bindingSecret,
    }))).toThrow(/distinct/i)
    expect(() => assertDeviceWipeSecretsConfigured(resolveDeviceWipeConfig({
      SECRETS_ENCRYPTION_KEY: bindingSecret,
      DEVICE_WIPE_BINDING_SECRET: bindingSecret,
      DEVICE_WIPE_CREDENTIAL_SECRET: credentialSecret,
    }))).toThrow(/distinct/i)
    expect(assertDeviceWipeSecretsConfigured(resolveDeviceWipeConfig({
      JWT_SECRET: 'j'.repeat(64),
      DEVICE_WIPE_BINDING_SECRET: bindingSecret,
      DEVICE_WIPE_CREDENTIAL_SECRET: credentialSecret,
    }))).toEqual({ bindingSecret, credentialSecret })
  })

  it.each(['HASURA_ADMIN_SECRET', 'DRUVIA_UPDATER_SECRET']) (
    'rejects reuse of the %s platform credential',
    (name) => {
      expect(() => assertDeviceWipeSecretsConfigured(resolveDeviceWipeConfig({
        [name]: bindingSecret,
        DEVICE_WIPE_BINDING_SECRET: bindingSecret,
        DEVICE_WIPE_CREDENTIAL_SECRET: credentialSecret,
      }))).toThrow(/distinct/i)
    },
  )

  it('derives stable purpose-separated secret verification tags', () => {
    const bindingTag = deriveDeviceWipeSecretVerification(bindingSecret, 'binding')
    const credentialTag = deriveDeviceWipeSecretVerification(credentialSecret, 'credential')

    expect(bindingTag).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(credentialTag).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(bindingTag).toBe(deriveDeviceWipeSecretVerification(bindingSecret, 'binding'))
    expect(bindingTag).not.toBe(deriveDeviceWipeSecretVerification(bindingSecret, 'credential'))
    expect(bindingTag).not.toBe(credentialTag)
  })
})

describe('project device wipe wire contract', () => {
  const command = buildDeviceWipeCommand({
    deletionId: '00000000-0000-4000-8000-000000000700',
    projectId: 'proj_PITCHETCH_TEST',
    projectUserFingerprint: 'mGGuQo29PUb5SBeP3kK3Wq2Fjsq0Ygq99vw7omUP-oY',
    bindingIdentityHmac: 'WOd2gVCckIZoOZp9vQXXiB4hdK0I5LGfY4rVQbrND9I',
    bindingRevision: 7,
    scope: 'account',
    sessionId: null,
  })
  const keyId = 'global-watch-ed25519-v1'
  const privateJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
  }

  it('matches the PITCHETCH sorted-key canonical signing payload', () => {
    expect(canonicalDeviceWipeSigningPayload(keyId, command).toString('utf8')).toBe(
      '{"command":{"bindingIdentityHMAC":"WOd2gVCckIZoOZp9vQXXiB4hdK0I5LGfY4rVQbrND9I","bindingRevision":7,"deletionID":{"rawValue":"00000000-0000-4000-8000-000000000700"},"projectID":"proj_PITCHETCH_TEST","projectUserFingerprint":"mGGuQo29PUb5SBeP3kK3Wq2Fjsq0Ygq99vw7omUP-oY","scope":{"kind":"account"},"version":1},"keyID":"global-watch-ed25519-v1","version":1}',
    )
  })

  it('matches a fixed Ed25519 signature vector and verifies with the public JWK', () => {
    const signature = signDeviceWipeCommand({ keyId, command, privateJwk })
    const publicJwk = createPublicKey({ key: privateJwk, format: 'jwk' }).export({ format: 'jwk' })

    expect(signature).toBe(
      'Mafk_BRsnsl89jQ1RyMfWZHTD04LWW_iX6z0sFxB8nVQj_bcrqgnQcBViZATT-kHWBZ06p7RPfwO3mxhljYoDQ',
    )
    expect(verifyDeviceWipeSignature({ keyId, command, signature, publicJwk })).toBe(true)
  })

  it('requires exactly one session id for a session scope', () => {
    expect(() => buildDeviceWipeCommand({
      deletionId: '00000000-0000-4000-8000-000000000700',
      projectId: 'proj_PITCHETCH_TEST',
      projectUserFingerprint: 'mGGuQo29PUb5SBeP3kK3Wq2Fjsq0Ygq99vw7omUP-oY',
      bindingIdentityHmac: 'WOd2gVCckIZoOZp9vQXXiB4hdK0I5LGfY4rVQbrND9I',
      bindingRevision: 7,
      scope: 'session',
      sessionId: null,
    })).toThrow(/session/i)
  })
})
