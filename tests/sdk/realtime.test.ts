import { describe, it, expect, vi } from 'vitest'
import { DruviaRealtime, RealtimeChannel } from '../../packages/sdk/src/modules/realtime.js'
import type { WebSocketFactory, WebSocketLike } from '../../packages/sdk/src/types.js'

function createMockWsFactory() {
  const handlers: Record<string, Function> = {}
  const ws: WebSocketLike & { _trigger: (event: string, data?: unknown) => void } = {
    onOpen: (cb) => { handlers['open'] = cb },
    onMessage: (cb) => { handlers['message'] = cb },
    onClose: (cb) => { handlers['close'] = cb },
    onError: (cb) => { handlers['error'] = cb },
    send: vi.fn(),
    close: vi.fn(),
    _trigger: (event, data) => { handlers[event]?.(data) },
  }
  const factory: WebSocketFactory = vi.fn().mockReturnValue(ws)
  return { factory, ws }
}

describe('DruviaRealtime', () => {
  it('channel() returns a RealtimeChannel', () => {
    const { factory } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const ch = rt.channel('test_channel')
    expect(ch).toBeInstanceOf(RealtimeChannel)
  })

  it('on() registers a callback and subscribe() connects', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()
    rt.channel('maintenance')
      .on('postgres_changes', { event: '*', table: 'system_config' }, callback)
      .subscribe()
    expect(factory).toHaveBeenCalled()
    ws._trigger('open')
    expect(ws.send).toHaveBeenCalled()
    const initMsg = JSON.parse((ws.send as any).mock.calls[0][0])
    expect(initMsg.type).toBe('connection_init')
  })

  it('emits INSERT event when new row appears', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()
    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'INSERT', new: { id: 2, name: 'B' } })
    )
  })

  it('emits UPDATE event when row changes', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()
    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A_updated' }] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'UPDATE', new: { id: 1, name: 'A_updated' }, old: { id: 1, name: 'A' } })
    )
  })

  it('emits DELETE event when row disappears', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const callback = vi.fn()
    rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, callback)
      .subscribe()

    ws._trigger('open')
    ws._trigger('message', JSON.stringify({ type: 'connection_ack' }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [{ id: 1, name: 'A' }] } }
    }))
    ws._trigger('message', JSON.stringify({
      type: 'data', id: '1',
      payload: { data: { items: [] } }
    }))

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'DELETE', old: { id: 1, name: 'A' } })
    )
  })

  it('unsubscribe() closes the WebSocket', () => {
    const { factory, ws } = createMockWsFactory()
    const rt = new DruviaRealtime('ws://localhost:8080/v1/graphql', factory)
    const sub = rt.channel('test')
      .on('postgres_changes', { event: '*', table: 'items' }, vi.fn())
      .subscribe()
    sub.unsubscribe()
    expect(ws.close).toHaveBeenCalled()
  })
})