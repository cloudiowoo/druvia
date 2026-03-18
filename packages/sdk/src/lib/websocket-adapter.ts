import type { WebSocketFactory, WebSocketLike } from '../types.js'

/** Default WebSocket factory — uses globalThis.WebSocket */
export function getDefaultWebSocketFactory(): WebSocketFactory | null {
  if (typeof globalThis.WebSocket === 'undefined') {
    return null
  }
  return (url: string, protocols?: string[]): WebSocketLike => {
    const ws = new globalThis.WebSocket(url, protocols)
    return {
      onOpen: (cb) => { ws.addEventListener('open', cb) },
      onMessage: (cb) => { ws.addEventListener('message', (e) => cb(String(e.data))) },
      onClose: (cb) => { ws.addEventListener('close', (e) => cb({ code: e.code, reason: e.reason })) },
      onError: (cb) => { ws.addEventListener('error', cb) },
      send: (data) => ws.send(data),
      close: () => ws.close(),
    }
  }
}
