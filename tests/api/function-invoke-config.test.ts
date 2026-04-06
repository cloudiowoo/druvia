import { describe, it, expect } from 'vitest'
import { resolveWorkerApiBaseUrl } from '../../apps/api/src/modules/functions/invoke-config.js'

describe('resolveWorkerApiBaseUrl', () => {
  it('prefers explicit internal api base url over public api base url', () => {
    expect(resolveWorkerApiBaseUrl({
      INTERNAL_API_BASE_URL: 'http://api:3001',
      API_BASE_URL: 'https://druvia.logisticservice.site',
    })).toBe('http://api:3001')
  })

  it('does not reuse public API_BASE_URL for worker internal callbacks', () => {
    expect(resolveWorkerApiBaseUrl({
      API_BASE_URL: 'https://druvia.logisticservice.site',
    })).toBeUndefined()
  })
})
