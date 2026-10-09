import type { ThemeState } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { accentShades } from '@shared/themes'

const root = document.documentElement

/**
 * Styles key off attributes on <html> (see app.css): `data-theme` (the theme in effect, from the
 * main process) plus the style choices from Settings → Appearance.
 */
export function applyTheme(state: ThemeState): void {
  root.dataset['theme'] = state.id
  // "Windows accent": legible shades of the system colour for light and dark surfaces.
  const shades = state.systemAccent ? accentShades(state.systemAccent) : null
  if (shades) {
    root.style.setProperty('--sys-accent', `light-dark(${shades.light}, ${shades.dark})`)
    root.style.setProperty('--sys-accent-strong', shades.strong)
    root.style.setProperty('--sys-accent-hover', shades.hover)
  }
}

export function applyAppearance(ui: Settings['ui'] | undefined): void {
  if (!ui) return
  root.dataset['accent'] = ui.accent
  root.dataset['density'] = ui.density
  root.dataset['corners'] = ui.corners
  root.dataset['font'] = ui.font
  root.style.setProperty('--scale', String(ui.fontScale ?? 1))
}

// Until the main process reports the theme in effect, use the media query it drives, so the
// first paint already has the right light/dark colours.
applyTheme({ id: window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' })
