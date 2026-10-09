/**
 * Appearance catalogue shared by the main process (window background, native light/dark) and the
 * renderers (Settings → Appearance). The colours themselves live in app.css, keyed off
 * `data-theme`, `data-accent`, `data-density`, `data-corners` and `data-font` on <html>.
 */

export type ThemeId = 'light' | 'paper' | 'dark' | 'midnight' | 'slate' | 'black' | 'contrast'
/** `system` follows the Windows app mode: Light or Dark. */
export type ThemePreference = 'system' | ThemeId
export type AccentId = 'system' | 'blue' | 'indigo' | 'violet' | 'teal' | 'green' | 'amber' | 'rose' | 'graphite'
export type Density = 'comfortable' | 'compact'
export type Corners = 'rounded' | 'square'
export type FontId = 'segoe' | 'bahnschrift' | 'calibri' | 'cascadia'

export interface ThemeInfo {
  id: ThemeId
  label: string
  description: string
  scheme: 'light' | 'dark'
  /** Window background before the page paints (matches --bg in app.css). */
  background: string
}

export const THEMES: ThemeInfo[] = [
  { id: 'light', label: 'Light', description: 'Clean, cool neutral', scheme: 'light', background: '#f5f6f8' },
  { id: 'paper', label: 'Paper', description: 'Warm and easy on the eyes', scheme: 'light', background: '#f4f1ea' },
  { id: 'dark', label: 'Dark', description: 'Neutral graphite', scheme: 'dark', background: '#111215' },
  { id: 'midnight', label: 'Midnight', description: 'Deep navy', scheme: 'dark', background: '#0b1120' },
  { id: 'slate', label: 'Slate', description: 'Soft blue-grey, lower contrast', scheme: 'dark', background: '#20242c' },
  { id: 'black', label: 'Black', description: 'True black for OLED screens', scheme: 'dark', background: '#000000' },
  { id: 'contrast', label: 'High contrast', description: 'Maximum legibility', scheme: 'dark', background: '#000000' }
]

export const ACCENTS: { id: AccentId; label: string }[] = [
  { id: 'blue', label: 'Blue' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'violet', label: 'Violet' },
  { id: 'teal', label: 'Teal' },
  { id: 'green', label: 'Green' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'system', label: 'Windows accent' }
]

export const FONTS: { id: FontId; label: string; family: string }[] = [
  { id: 'segoe', label: 'Segoe UI', family: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
  { id: 'bahnschrift', label: 'Bahnschrift', family: "Bahnschrift, 'Segoe UI', system-ui, sans-serif" },
  { id: 'calibri', label: 'Calibri', family: "Calibri, 'Segoe UI', system-ui, sans-serif" },
  { id: 'cascadia', label: 'Cascadia', family: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" }
]

export function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[2]
}

/** The theme to show for a preference: `system` picks Light or Dark from the Windows app mode. */
export function resolveTheme(pref: ThemePreference, osDark: boolean): ThemeId {
  if (pref === 'system') return osDark ? 'dark' : 'light'
  return pref
}

// ---------------------------------------------------------------- Windows accent colour

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  if (!ra || !rb) return 1
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Mix towards black (amount < 0) or white (amount > 0). */
function mix(rgb: Rgb, amount: number): Rgb {
  const t = amount < 0 ? 0 : 255
  const a = Math.abs(amount)
  return rgb.map((v) => v + (t - v) * a) as Rgb
}

/** Darken or lighten `hex` in small steps until it reaches `min` contrast against `against`. */
function untilContrast(hex: string, against: string, min: number, direction: -1 | 1): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  for (let step = 0; step <= 20; step++) {
    const candidate = rgbToHex(mix(rgb, direction * step * 0.05))
    if (contrastRatio(candidate, against) >= min) return candidate
  }
  return direction < 0 ? '#000000' : '#ffffff'
}

export interface AccentShades {
  /** Buttons and filled controls (white text on it), the same in light and dark themes. */
  strong: string
  hover: string
  /** Accent text, icons and focus rings on light backgrounds. */
  light: string
  /** Accent text, icons and focus rings on dark backgrounds. */
  dark: string
}

/**
 * Shades of the Windows accent colour that stay legible: filled buttons keep white text at
 * 4.5:1, and accent text keeps 4.5:1 against light and dark surfaces.
 */
export function accentShades(hex: string): AccentShades | null {
  if (!hexToRgb(hex)) return null
  const strong = untilContrast(hex, '#ffffff', 4.5, -1)
  return {
    strong,
    hover: rgbToHex(mix(hexToRgb(strong)!, -0.12)),
    light: untilContrast(hex, '#ffffff', 4.6, -1),
    dark: untilContrast(hex, '#16171b', 4.6, 1)
  }
}
