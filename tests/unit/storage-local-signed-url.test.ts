import { beforeEach, describe, expect, it } from 'vitest'
import { LocalAdapter } from '../../apps/api/src/adapters/storage/local.adapter.js'

describe('Local storage signed URL', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'storage-signing-secret'
    process.env.API_BASE_URL = 'http://localhost:3001'
  })

  it('covers logical filename and content type in the signature', async () => {
    const adapter = new LocalAdapter({ basePath: '/tmp/druvia-test', publicUrl: '/storage' })
    const url = new URL(await adapter.getSignedUrl('proj/bucket/objects/obj_1', 3600, {
      logicalName: 'folder/a b.png',
      contentType: 'image/png',
    }))
    const expires = url.searchParams.get('expires')!
    const signature = url.searchParams.get('signature')!
    expect(LocalAdapter.verifySignature('proj/bucket/objects/obj_1', expires, signature, {
      logicalName: 'folder/a b.png', contentType: 'image/png',
    })).toBe(true)
    expect(LocalAdapter.verifySignature('proj/bucket/objects/obj_1', expires, signature, {
      logicalName: 'folder/other.png', contentType: 'image/png',
    })).toBe(false)
  })

  it.each(['', 'abc', '-1', '1.5'])(`rejects malformed expiry %s`, (expires) => {
    expect(LocalAdapter.verifySignature('path', expires, 'a'.repeat(64))).toBe(false)
  })

  it.each(['short', 'A'.repeat(64), 'g'.repeat(64)])('rejects malformed signatures without throwing', (signature) => {
    expect(() => LocalAdapter.verifySignature('path', '9999999999', signature)).not.toThrow()
    expect(LocalAdapter.verifySignature('path', '9999999999', signature)).toBe(false)
  })

  it('keeps the option-absent legacy signature branch', () => {
    const expires = '9999999999'
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const signature = crypto.createHmac('sha256', process.env.JWT_SECRET!).update(`path:${expires}`).digest('hex')
    expect(LocalAdapter.verifySignature('path', expires, signature)).toBe(true)
  })
})
