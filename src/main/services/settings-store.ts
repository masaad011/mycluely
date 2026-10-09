import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { DeepPartial, Settings } from '@shared/settings'
import { readJson, SerialQueue, writeFileAtomic } from './json-file'
import { deepMerge, sanitizeSettings } from './settings-schema'

/** Non-secret preferences, persisted as JSON in the user-data folder. API keys never go here. */
export class SettingsStore extends EventEmitter {
  private settings: Settings
  private readonly file: string
  private readonly queue = new SerialQueue()

  private constructor(dir: string, initial: Settings) {
    super()
    this.file = path.join(dir, 'settings.json')
    this.settings = initial
  }

  static async open(dir: string): Promise<SettingsStore> {
    const raw = await readJson<unknown>(path.join(dir, 'settings.json'))
    return new SettingsStore(dir, sanitizeSettings(raw))
  }

  get(): Settings {
    return this.settings
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    const prev = this.settings
    const next = sanitizeSettings(deepMerge(structuredClone(prev) as unknown as Record<string, unknown>, patch as Record<string, unknown>))
    // Records like visionOverrides/baseUrls are replaced wholesale when provided so keys can be removed.
    if (patch.ai?.visionOverrides) next.ai.visionOverrides = { ...(patch.ai.visionOverrides as Record<string, boolean>) }
    if (patch.ai?.baseUrls) {
      next.ai.baseUrls = Object.fromEntries(
        Object.entries(patch.ai.baseUrls).filter(([, v]) => typeof v === 'string' && v.trim())
      ) as Settings['ai']['baseUrls']
    }
    this.settings = next
    await this.save()
    this.emit('change', next, prev)
    return next
  }

  async reset(): Promise<Settings> {
    const prev = this.settings
    this.settings = sanitizeSettings({})
    await this.save()
    this.emit('change', this.settings, prev)
    return this.settings
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2)
    return this.queue.run(() => writeFileAtomic(this.file, snapshot))
  }
}
