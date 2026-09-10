import { describe, expect, it } from 'vitest'
import { resolveAccountDeletionConfig } from '../../apps/api/src/config/index.js'

import {
  deriveAccountDeletionReauthNonce,
  deriveAccountDeletionStatusToken,
  fingerprintAccountDeletionSubject,
  verifyAccountDeletionStatusToken,
} from '../../apps/api/src/modules/project-auth/project-account-deletion.crypto.js'

const statusSecret = 's'.repeat(64)
const fenceSecret = 'f'.repeat(64)
const deletionId = '5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e'

describe('project account deletion credentials', () => {
  it('derives stable credentials with separate domains', () => {
    const input = { secret: statusSecret, projectId: 'proj_123', deletionId }

    const statusToken = deriveAccountDeletionStatusToken(input)
    const reauthNonce = deriveAccountDeletionReauthNonce(input)

    expect(statusToken).toHaveLength(43)
    expect(reauthNonce).toHaveLength(43)
    expect(statusToken).not.toBe(reauthNonce)
    expect(deriveAccountDeletionStatusToken(input)).toBe(statusToken)
    expect(deriveAccountDeletionReauthNonce(input)).toBe(reauthNonce)
  })

  it('binds a status token to the project and operation', () => {
    const token = deriveAccountDeletionStatusToken({
      secret: statusSecret,
      projectId: 'proj_123',
      deletionId,
    })

    expect(verifyAccountDeletionStatusToken({
      secret: statusSecret,
      projectId: 'proj_123',
      deletionId,
      token,
    })).toBe(true)
    expect(verifyAccountDeletionStatusToken({
      secret: statusSecret,
      projectId: 'proj_other',
      deletionId,
      token,
    })).toBe(false)
    expect(verifyAccountDeletionStatusToken({
      secret: statusSecret,
      projectId: 'proj_123',
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
      token,
    })).toBe(false)
    expect(verifyAccountDeletionStatusToken({
      secret: statusSecret,
      projectId: 'proj_123',
      deletionId,
      token: `${token.slice(0, -1)}x`,
    })).toBe(false)
  })

  it('fingerprints provider subjects without exposing the subject', () => {
    const first = fingerprintAccountDeletionSubject({
      secret: fenceSecret,
      projectId: 'proj_123',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'private-apple-subject',
    })
    const second = fingerprintAccountDeletionSubject({
      secret: fenceSecret,
      projectId: 'proj_123',
      provider: 'apple',
      issuer: 'https://appleid.apple.com',
      subject: 'private-apple-subject',
    })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).toBe(second)
    expect(first).not.toContain('private-apple-subject')
  })
})

describe('project account deletion configuration', () => {
  it('requires two dedicated production secrets', () => {
    expect(() => resolveAccountDeletionConfig({
      NODE_ENV: 'production',
      ACCOUNT_DELETION_STATUS_SECRET: 'same'.repeat(16),
      ACCOUNT_DELETION_FENCE_SECRET: 'same'.repeat(16),
    })).toThrow(/distinct/i)

    expect(() => resolveAccountDeletionConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(64),
      ACCOUNT_DELETION_STATUS_SECRET: 'j'.repeat(64),
      ACCOUNT_DELETION_FENCE_SECRET: 'f'.repeat(64),
    })).toThrow(/distinct/i)
  })
})
