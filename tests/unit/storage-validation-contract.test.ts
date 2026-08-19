import { describe, expect, it } from 'vitest'
import {
  MAX_STORAGE_OBJECT_BYTES,
  normalizeAllowedStorageMimeTypes,
  safeStorageResponseMimeType,
  normalizeStorageFileSizeLimit,
  normalizeStorageMimeType,
} from '../../apps/api/src/modules/storage/storage-validation.js'

describe('storage validation contract', () => {
  it('normalizes and deduplicates exact MIME types', () => {
    expect(normalizeAllowedStorageMimeTypes(['Image/PNG', 'image/png', 'text/plain']))
      .toEqual(['image/png', 'text/plain'])
  })

  it.each(['image/*', 'text/html; charset=utf-8', 'bad', 'image/ png', 'image/\u0000png'])(
    'rejects malformed MIME %s',
    (mime) => expect(() => normalizeStorageMimeType(mime)).toThrow()
  )

  it('accepts null and positive safe limits through 50 MB', () => {
    expect(normalizeStorageFileSizeLimit(null)).toBeNull()
    expect(normalizeStorageFileSizeLimit(MAX_STORAGE_OBJECT_BYTES)).toBe(MAX_STORAGE_OBJECT_BYTES)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, MAX_STORAGE_OBJECT_BYTES + 1])(
    'rejects invalid size %s',
    (size) => expect(() => normalizeStorageFileSizeLimit(size)).toThrow()
  )

  it('falls back for malformed legacy response MIME values', () => {
    expect(safeStorageResponseMimeType(' Image/PNG ')).toBe('image/png')
    expect(safeStorageResponseMimeType('text/html\r\nx-test: injected'))
      .toBe('application/octet-stream')
    expect(safeStorageResponseMimeType(null)).toBe('application/octet-stream')
  })
})
