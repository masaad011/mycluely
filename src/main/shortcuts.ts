import { globalShortcut } from 'electron'
import { ALWAYS_ON_SHORTCUTS, type Settings } from '@shared/settings'
import type { ShortcutAction } from '@shared/types'
import { SHORTCUT_LABELS } from '@shared/types'

export type ShortcutHandlers = Record<ShortcutAction, () => void>

/**
 * Registers global hotkeys from settings. Registration fails silently in Electron when another
 * app owns the combination, so failures are collected and reported to the user.
 */
export class ShortcutManager {
  private registered: string[] = []

  constructor(private readonly handlers: ShortcutHandlers) {}

  /**
   * Register shortcuts. Outside a live meeting only the always-on ones (panel toggle) are
   * registered, so MyCluely never intercepts other apps' key combinations needlessly.
   */
  apply(shortcuts: Settings['shortcuts'], live: boolean): string[] {
    this.clear()
    const failed: string[] = []
    const seen = new Set<string>()
    for (const [action, accel] of Object.entries(shortcuts) as [ShortcutAction, string][]) {
      if (!accel?.trim()) continue
      if (!live && !ALWAYS_ON_SHORTCUTS.includes(action)) continue
      const key = accel.toLowerCase()
      if (seen.has(key)) {
        failed.push(`${SHORTCUT_LABELS[action]} (${accel}: duplicate)`)
        continue
      }
      seen.add(key)
      try {
        const ok = globalShortcut.register(accel, () => this.handlers[action]())
        if (ok) this.registered.push(accel)
        else failed.push(`${SHORTCUT_LABELS[action]} (${accel}: in use by another app)`)
      } catch {
        failed.push(`${SHORTCUT_LABELS[action]} (${accel}: invalid)`)
      }
    }
    return failed
  }

  clear(): void {
    for (const a of this.registered) globalShortcut.unregister(a)
    this.registered = []
  }
}
