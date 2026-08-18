import { describe, expect, it, vi } from 'vitest'

import {
  buildTrustedHeaders,
  createWorkerHandler,
} from '../../docker/deno-worker/worker-handler.ts'
import type { DenoLogger } from '../../docker/deno-worker/logging.ts'

const workerSecret = 'worker-secret-with-at-least-32-bytes'
const caller = {
  actorContractVersion: 1 as const,
  actorType: 'project_user' as const,
  actorSource: 'project_session' as const,
  actorSubject: 'project_user:pu_123',
  authType: 'project_user' as const,
  projectId: 'proj_123',
  role: 'authenticated',
  projectUserId: 'pu_123',
  provider: 'wechat',
}

function loggerStub(): DenoLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function child() { return loggerStub() }),
  }
}

function executionBody(overrides: Record<string, unknown> = {}) {
  return {
    code: 'return { ok: true }',
    functionName: 'demo',
    executionId: 'exec_123',
    secrets: {},
    payload: { id: 1 },
    caller,
    internalToken: 'signed-internal-token',
    timeout: 30_000,
    ...overrides,
  }
}

describe('Deno Worker request authentication', () => {
  it('builds trusted compatibility headers only from the validated caller', () => {
    const headers = buildTrustedHeaders(caller)

    expect(Object.fromEntries(headers)).toMatchObject({
      'x-druvia-auth-type': 'project_user',
      'x-druvia-actor-type': 'project_user',
      'x-druvia-actor-source': 'project_session',
      'x-druvia-actor-subject': 'project_user:pu_123',
      'x-druvia-actor-contract-version': '1',
      'x-druvia-project-id': 'proj_123',
      'x-druvia-role': 'authenticated',
      'x-druvia-project-user-id': 'pu_123',
      'x-druvia-provider': 'wechat',
    })
    expect(headers.has('x-hasura-admin-secret')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
  })

  it('keeps health public and non-sensitive', async () => {
    const executeFunction = vi.fn()
    const handler = createWorkerHandler({ workerSecret, logger: loggerStub(), executeFunction })

    const response = await handler(new Request('http://worker/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', runtime: 'deno' })
    expect(executeFunction).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['incorrect', 'incorrect-worker-secret-with-32-bytes'],
  ])('rejects %s credentials before parsing the request body', async (_label, secret) => {
    const executeFunction = vi.fn()
    const handler = createWorkerHandler({ workerSecret, logger: loggerStub(), executeFunction })
    const request = new Request('http://worker/execute', {
      method: 'POST',
      headers: secret ? { 'x-druvia-worker-secret': secret } : {},
      body: JSON.stringify(executionBody()),
    })
    const jsonSpy = vi.spyOn(request, 'json')

    const response = await handler(request)

    expect(response.status).toBe(401)
    expect(jsonSpy).not.toHaveBeenCalled()
    expect(executeFunction).not.toHaveBeenCalled()
  })

  it.each([
    ['missing caller', { caller: undefined }],
    ['missing token', { internalToken: '' }],
    ['mismatched legacy actor type', { caller: { ...caller, authType: 'apikey' } }],
    ['mismatched project user subject', {
      caller: { ...caller, actorSubject: 'project_user:other' },
    }],
    ['cross-variant identity fields', {
      caller: { ...caller, apiKeyId: 17, apiKeyPrefix: 'drv_test' },
    }],
  ])('rejects a validly authenticated envelope with %s before execution', async (_label, overrides) => {
    const executeFunction = vi.fn()
    const handler = createWorkerHandler({ workerSecret, logger: loggerStub(), executeFunction })
    const request = new Request('http://worker/execute', {
      method: 'POST',
      headers: { 'x-druvia-worker-secret': workerSecret },
      body: JSON.stringify(executionBody(overrides)),
    })

    const response = await handler(request)

    expect(response.status).toBe(400)
    expect(executeFunction).not.toHaveBeenCalled()
  })

  it('executes a validated canonical envelope after successful authentication', async () => {
    const executeFunction = vi.fn().mockResolvedValue({
      success: true,
      data: { ok: true },
      durationMs: 12,
    })
    const handler = createWorkerHandler({ workerSecret, logger: loggerStub(), executeFunction })
    const request = new Request('http://worker/execute', {
      method: 'POST',
      headers: { 'x-druvia-worker-secret': workerSecret },
      body: JSON.stringify(executionBody()),
    })

    const response = await handler(request)

    expect(response.status).toBe(200)
    expect(executeFunction).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'demo',
      caller,
      internalToken: 'signed-internal-token',
    }))
    expect(await response.json()).toMatchObject({ success: true, data: { ok: true } })
  })
})
