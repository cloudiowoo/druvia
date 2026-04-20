// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

describe('admin jsdom smoke', () => {
  it('provides browser globals for admin UI tests', () => {
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement)
  })
})
