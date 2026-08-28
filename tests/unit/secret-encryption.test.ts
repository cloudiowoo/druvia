import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decryptSecret,
  encryptSecret,
  SecretEncryptionConfigError,
} from '../../apps/api/src/lib/secret-encryption.js'

const originalEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY
const originalJwtSecret = process.env.JWT_SECRET

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
  else process.env.SECRETS_ENCRYPTION_KEY = originalEncryptionKey
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

describe('secret encryption', () => {
  it('round trips the legacy iv:authTag:ciphertext envelope', () => {
    process.env.SECRETS_ENCRYPTION_KEY = 'dedicated-secret-encryption-key-1234567890'

    const encrypted = encryptSecret('provider-secret')

    expect(encrypted.split(':')).toHaveLength(3)
    expect(decryptSecret(encrypted)).toBe('provider-secret')
  })

  it('retains JWT secret fallback for legacy providers', () => {
    delete process.env.SECRETS_ENCRYPTION_KEY
    process.env.JWT_SECRET = 'legacy-jwt-secret'

    const encrypted = encryptSecret('legacy-provider-secret')

    expect(decryptSecret(encrypted)).toBe('legacy-provider-secret')
  })

  it('requires a dedicated non-placeholder key for Apple material', () => {
    delete process.env.SECRETS_ENCRYPTION_KEY
    process.env.JWT_SECRET = 'legacy-jwt-secret'

    expect(() => encryptSecret('apple-private-key', { requireDedicatedKey: true }))
      .toThrow(SecretEncryptionConfigError)

    process.env.SECRETS_ENCRYPTION_KEY = 'change-me'
    expect(() => encryptSecret('apple-private-key', { requireDedicatedKey: true }))
      .toThrow(SecretEncryptionConfigError)

    process.env.SECRETS_ENCRYPTION_KEY = 'change_me_to_a_distinct_secret_encryption_key_min_32_chars'
    expect(() => encryptSecret('apple-private-key', { requireDedicatedKey: true }))
      .toThrow(SecretEncryptionConfigError)

    process.env.SECRETS_ENCRYPTION_KEY = 'your_distinct_secret_encryption_key_min_32_characters'
    expect(() => encryptSecret('apple-private-key', { requireDedicatedKey: true }))
      .toThrow(SecretEncryptionConfigError)
  })

  it('redacts every Apple credential field and logs only safe audit identifiers', () => {
    const appSource = readFileSync('apps/api/src/index.ts', 'utf8')
    const authSource = readFileSync(
      'apps/api/src/modules/project-auth/project-auth.service.ts',
      'utf8',
    )

    for (const path of [
      'req.body.authorizationCode',
      'req.body.identityToken',
      'req.body.rawNonce',
      'req.body.payload',
      'providerRefreshToken',
    ]) {
      expect(appSource).toContain(`'${path}'`)
    }
    expect(authSource).toMatch(/logger\.warn\('Apple project login local persistence failed',[\s\S]*errorCode:/)
    expect(authSource).not.toMatch(/logger\.(?:info|warn|error)\([^)]*(?:authorizationCode|identityToken|rawNonce|providerSession\.refreshToken)/)
  })
})
