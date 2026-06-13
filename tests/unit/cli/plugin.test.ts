import { describe, it, expect } from 'vitest'
import { resolvePlugin, type IngestionPlugin } from '../../../src/cli/plugin.js'

const validPlugin: IngestionPlugin = {
  name: 'sample',
  run: () => {
    /* no-op */
  },
}

describe('resolvePlugin', () => {
  it('accepts a default-exported plugin object', () => {
    const mod = { default: validPlugin }
    expect(resolvePlugin(mod)).toBe(validPlugin)
  })

  it('accepts a default-exported factory that returns a plugin', () => {
    const mod = { default: (): IngestionPlugin => validPlugin }
    expect(resolvePlugin(mod)).toBe(validPlugin)
  })

  it('rejects modules with no default export', () => {
    expect(() => resolvePlugin({ named: validPlugin })).toThrow(/`default` export/)
  })

  it('rejects null modules with a helpful message', () => {
    expect(() => resolvePlugin(null)).toThrow(/did not export/)
  })

  it('rejects plugin missing `name`', () => {
    const mod = { default: { run: (): void => undefined } }
    expect(() => resolvePlugin(mod)).toThrow(/IngestionPlugin/)
  })

  it('rejects plugin missing `run`', () => {
    const mod = { default: { name: 'broken' } }
    expect(() => resolvePlugin(mod)).toThrow(/IngestionPlugin/)
  })

  it('rejects factory that returns garbage', () => {
    const mod = { default: () => 42 }
    expect(() => resolvePlugin(mod)).toThrow(/factory did not return/)
  })
})
