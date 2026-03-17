import { describe, it, expect, vi } from 'vitest'
import { DruviaRpc } from '../../packages/sdk/src/modules/rpc.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'

describe('DruviaRpc', () => {
  const projectId = 'proj_123'

  it('rpc() sends POST to /rpc/:functionName', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 1, confirmed: true }], error: null }),
    }) as unknown as FetchFn
    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    const result = await rpc.call('confirm_drafts', { match_id: 1 })
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/rpc/confirm_drafts`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ args: { match_id: 1 } }) })
    )
    expect(result.data).toEqual([{ id: 1, confirmed: true }])
    expect(result.error).toBeNull()
  })

  it('rpc() with no args sends empty args', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: null, error: null }),
    }) as unknown as FetchFn
    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    await rpc.call('cleanup_data')
    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.args).toEqual({})
  })

  it('handles error response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'Function not found' } }),
    }) as unknown as FetchFn
    const rpc = new DruviaRpc('/api/v1', projectId, fetch)
    const result = await rpc.call('nonexistent_fn', {})
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('NOT_FOUND')
  })
})
