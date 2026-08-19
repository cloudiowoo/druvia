import { describe, expect, it, vi } from 'vitest'
import {
  applyStorageDeliveryHeaders,
  storageContentDisposition,
} from '../../apps/api/src/modules/storage/storage-delivery.js'

function captureHeaders() {
  const headers = new Map<string, string>()
  const reply = { header: vi.fn((key: string, value: string) => headers.set(key, value)) }
  return { reply, headers }
}

describe('storage delivery policy', () => {
  it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])(
    'forces public %s to attachment',
    (mimeType) => {
      const { reply, headers } = captureHeaders()
      applyStorageDeliveryHeaders(reply as never, { mimeType, logicalName: 'unsafe.svg', public: true })
      expect(headers.get('Content-Disposition')).toMatch(/^attachment;/)
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
      expect(headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate')
    }
  )

  it('allows only a safe public image type inline', () => {
    const { reply, headers } = captureHeaders()
    applyStorageDeliveryHeaders(reply as never, { mimeType: 'image/png', logicalName: '中文.png', public: true })
    expect(headers.get('Content-Disposition')).toMatch(/^inline;/)
  })

  it('forces protected downloads to private attachments', () => {
    const { reply, headers } = captureHeaders()
    applyStorageDeliveryHeaders(reply as never, { mimeType: 'image/png', logicalName: 'a.png', public: false })
    expect(headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('does not copy malformed legacy MIME values into response headers', () => {
    const { reply, headers } = captureHeaders()
    applyStorageDeliveryHeaders(reply as never, {
      mimeType: 'text/html\r\nx-test: injected',
      logicalName: 'legacy.bin',
      public: true,
    })
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('Content-Disposition')).toMatch(/^attachment;/)
  })

  it('encodes non-ASCII filenames without header injection', () => {
    expect(storageContentDisposition('folder/中\r\n文.png', false)).not.toContain('\r')
    expect(storageContentDisposition('folder/中\r\n文.png', false)).not.toContain('\n')
    expect(storageContentDisposition("folder/team's (final).png", false))
      .toContain("filename*=UTF-8''team%27s%20%28final%29.png")
  })
})
