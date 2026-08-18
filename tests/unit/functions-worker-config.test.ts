import { describe, expect, it } from 'vitest'

import { resolveFunctionsConfig } from '../../apps/api/src/config/index.js'

const strongWorkerSecret = 'worker-secret-with-at-least-32-bytes'
const strongTokenSecret = 'function-token-secret-with-32-bytes'

describe('Functions Worker configuration', () => {
  it('keeps the Worker credential separate from the internal Function token secret', () => {
    expect(resolveFunctionsConfig({
      DENO_WORKER_SECRET: strongWorkerSecret,
      FUNCTIONS_INTERNAL_TOKEN_SECRET: strongTokenSecret,
      JWT_SECRET: 'jwt-secret-with-at-least-32-bytes',
    })).toMatchObject({
      workerSecret: strongWorkerSecret,
      internalTokenSecret: strongTokenSecret,
    })
  })

  it('uses the documented token/JWT fallback chain during initialization', () => {
    expect(resolveFunctionsConfig({
      FUNCTIONS_INTERNAL_TOKEN_SECRET: strongTokenSecret,
    }).workerSecret).toBe(strongTokenSecret)

    expect(resolveFunctionsConfig({
      JWT_SECRET: 'jwt-secret-with-at-least-32-bytes',
    }).workerSecret).toBe('jwt-secret-with-at-least-32-bytes')
  })

  it.each([
    ['missing', {}],
    ['short', { DENO_WORKER_SECRET: 'too-short' }],
    ['sub-32-byte Unicode', { DENO_WORKER_SECRET: '密码'.repeat(5) }],
  ])('rejects %s Worker credentials', (_label, env) => {
    expect(() => resolveFunctionsConfig(env)).toThrow(/at least 32 UTF-8 bytes/i)
  })
})
