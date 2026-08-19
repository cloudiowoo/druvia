import { describe, expect, it } from 'vitest'
import {
  encodeStorageObjectPath,
  normalizeStorageObjectPath,
  normalizeStoragePathPrefix,
  storageLikePrefix,
} from '../../apps/api/src/modules/storage/storage-path.js'
import {
  invalidStoragePathCases,
  urlStoragePathCases,
  validStoragePathCases,
} from '../fixtures/storage-path-cases.js'

describe('storage path contract', () => {
  it.each(validStoragePathCases)('normalizes %s', (_label, input, expected) => {
    expect(normalizeStorageObjectPath(input)).toBe(expected)
  })

  it.each(invalidStoragePathCases)('rejects %s', (input) => {
    expect(() => normalizeStorageObjectPath(input)).toThrow()
  })

  it('normalizes a prefix with exactly one optional trailing slash', () => {
    expect(normalizeStoragePathPrefix('')).toBe('')
    expect(normalizeStoragePathPrefix('/avatars')).toBe('avatars')
    expect(normalizeStoragePathPrefix('avatars/')).toBe('avatars/')
    expect(() => normalizeStoragePathPrefix('avatars//')).toThrow()
  })

  it('escapes SQL LIKE metacharacters literally', () => {
    expect(storageLikePrefix('100%_done\\')).toBe('100\\%\\_done\\\\%')
  })

  it.each(urlStoragePathCases)('encodes URL segments for %s', (input, expected) => {
    expect(encodeStorageObjectPath(input)).toBe(expected)
  })
})
