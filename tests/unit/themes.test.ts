import { describe, expect, it } from 'vitest'
import { accentShades, contrastRatio, resolveTheme, THEMES, themeInfo } from '../../src/shared/themes'
import { sanitizeSettings } from '../../src/main/services/settings-schema'

describe('appearance', () => {
  it('resolves System to Light or Dark and knows each theme’s light/dark scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('midnight', false)).toBe('midnight')
    expect(themeInfo('paper').scheme).toBe('light')
    expect(themeInfo('contrast').scheme).toBe('dark')
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
  })

  it('derives legible shades from any Windows accent colour', () => {
    for (const hex of ['#0078d4', '#ffb900', '#00b7c3', '#e81123', '#bfbfbf', '#1e1e1e']) {
      const s = accentShades(hex)!
      expect(contrastRatio(s.strong, '#ffffff')).toBeGreaterThanOrEqual(4.5) // white button text
      expect(contrastRatio(s.light, '#ffffff')).toBeGreaterThanOrEqual(4.5) // accent text on light
      expect(contrastRatio(s.dark, '#16171b')).toBeGreaterThanOrEqual(4.5) // accent text on dark
    }
    expect(accentShades('not a colour')).toBeNull()
    // Windows reports RRGGBBAA; the alpha byte is ignored.
    expect(accentShades('0078d4ff')).not.toBeNull()
  })

  it('keeps valid appearance choices and repairs unknown ones', () => {
    const ui = sanitizeSettings({ ui: { theme: 'midnight', accent: 'teal', density: 'compact', corners: 'square', font: 'bahnschrift' } }).ui
    expect(ui).toMatchObject({ theme: 'midnight', accent: 'teal', density: 'compact', corners: 'square', font: 'bahnschrift' })
    const bad = sanitizeSettings({ ui: { theme: 'neon', accent: 'chartreuse', density: 'huge', corners: 'blob', font: 'comic' } }).ui
    expect(bad).toMatchObject({ theme: 'system', accent: 'blue', density: 'comfortable', corners: 'rounded', font: 'segoe' })
  })
})
