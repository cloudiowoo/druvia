import { describe, it, expect, vi } from 'vitest'
import { DruviaFunctions } from '../../packages/sdk/src/modules/functions.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaFunctions', () => {
  const projectId = 'proj_123'

  it('invoke() sends POST to /functions/:name/invoke', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: 1 }, token: 'tok' }),
    }) as unknown as FetchFn
    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    const result = await fns.invoke('wx-silent-login', { body: { code: 'wx_code' } })
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/functions/wx-silent-login/invoke`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'wx_code' }) })
    )
    expect(result.data).toEqual({ user: { id: 1 }, token: 'tok' })
  })

  it('invoke() without body sends empty object', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'ok' }),
    }) as unknown as FetchFn
    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    await fns.invoke('health-check')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('health-check/invoke'),
      expect.objectContaining({ body: '{}' })
    )
  })

  it('handles invoke error', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'FUNCTION_ERROR', message: 'Runtime error' } }),
    }) as unknown as FetchFn
    const fns = new DruviaFunctions('/api/v1', projectId, fetch)
    const result = await fns.invoke('broken-fn')
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('FUNCTION_ERROR')
  })
})
