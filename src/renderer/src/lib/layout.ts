import type { PanelId, PanelLayout } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { DeepPartial } from '@shared/settings'
import { safe } from './actions'
import { api } from './api'
import { getState } from './store'

export const DEFAULT_LAYOUT = DEFAULT_SETTINGS.ui.layout

/** Save part of the Live view layout (persisted with the settings, so it survives restarts). */
export function updateLayout(patch: DeepPartial<PanelLayout>): void {
  void safe(() => api.invoke('settings:update', { ui: { layout: patch } }), 'Could not save the layout')
}

export function toggleCollapsed(id: PanelId): void {
  const layout = getState()?.settings.ui.layout ?? DEFAULT_LAYOUT
  updateLayout({ collapsed: { [id]: !layout.collapsed[id] }, maximized: null })
}

export function expandPanel(id: PanelId): void {
  updateLayout({ collapsed: { [id]: false }, maximized: null })
}

/** Fill the Live view with one panel, or restore the normal layout. */
export function toggleMaximized(id: PanelId): void {
  const layout = getState()?.settings.ui.layout ?? DEFAULT_LAYOUT
  updateLayout(layout.maximized === id ? { maximized: null } : { maximized: id, collapsed: { [id]: false } })
}
