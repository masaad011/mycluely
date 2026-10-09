import path from 'node:path'
import type { CredentialStatus, ProviderId } from '@shared/types'
import { PROVIDER_IDS } from '@shared/types'
import { readJson, SerialQueue, writeFileAtomic } from './json-file'

/** OS-backed encryption (Electron safeStorage: DPAPI on Windows, Keychain on macOS). */
export interface Encryptor {
  isAvailable(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(cipher: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>
}

/** Environment variables honoured as a read-only fallback (useful for CI/dev). */
export const ENV_KEYS: Record<ProviderId, string[]> = {
  chatgpt: [], // signed in with a ChatGPT account, not an API key
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY']
}

type StoredFile = Partial<Record<ProviderId, string>>

/**
 * API keys are encrypted with the OS credential protection before touching disk and are only
 * decrypted in the main process when a request is made. The renderer only ever sees a status
 * with the last four characters.
 */
export class CredentialStore {
  private readonly file: string
  private readonly queue = new SerialQueue()
  private cache = new Map<ProviderId, string>()
  /** Providers whose saved key exists on disk but could not be decrypted. */
  private undecryptable = new Set<ProviderId>()
  private loaded = false

  constructor(
    dir: string,
    private readonly enc: Encryptor,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.file = path.join(dir, 'credentials.json')
  }

  private async load(): Promise<StoredFile> {
    return (await readJson<StoredFile>(this.file)) ?? {}
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const stored = await this.load()
    for (const id of PROVIDER_IDS) {
      const b64 = stored[id]
      if (!b64) continue
      try {
        const { value, shouldReEncrypt } = await this.enc.decrypt(Buffer.from(b64, 'base64'))
        this.cache.set(id, value)
        if (shouldReEncrypt) await this.set(id, value)
      } catch {
        // E.g. the profile was copied from another Windows account: report it, don't hide it.
        this.undecryptable.add(id)
      }
    }
    this.loaded = true
  }

  async get(id: ProviderId): Promise<string | undefined> {
    await this.ensureLoaded()
    const stored = this.cache.get(id)
    if (stored) return stored
    for (const name of ENV_KEYS[id]) {
      const v = this.env[name]?.trim()
      if (v) return v
    }
    return undefined
  }

  async set(id: ProviderId, apiKey: string): Promise<void> {
    const key = apiKey.trim()
    if (!key) return this.clear(id)
    if (key.length > 4096 || /\s/.test(key)) throw new Error('That does not look like an API key.')
    if (!(await this.enc.isAvailable())) {
      throw new Error('Secure OS credential storage is not available, so the key was not saved.')
    }
    const cipher = await this.enc.encrypt(key)
    // Make sure what we write can be read back before reporting success.
    const check = await this.enc.decrypt(cipher)
    if (check.value !== key) throw new Error('Secure storage did not round-trip the key; it was not saved.')
    await this.queue.run(async () => {
      const stored = await this.load()
      stored[id] = cipher.toString('base64')
      await writeFileAtomic(this.file, JSON.stringify(stored, null, 2))
    })
    this.cache.set(id, key)
    this.undecryptable.delete(id)
  }

  async clear(id: ProviderId): Promise<void> {
    await this.queue.run(async () => {
      const stored = await this.load()
      delete stored[id]
      await writeFileAtomic(this.file, JSON.stringify(stored, null, 2))
    })
    this.cache.delete(id)
    this.undecryptable.delete(id)
  }

  async status(): Promise<Record<ProviderId, CredentialStatus>> {
    await this.ensureLoaded()
    const out = {} as Record<ProviderId, CredentialStatus>
    for (const id of PROVIDER_IDS) {
      const stored = this.cache.get(id)
      if (stored) {
        out[id] = { configured: true, source: 'stored', hint: stored.slice(-4) }
        continue
      }
      const envName = ENV_KEYS[id].find((n) => this.env[n]?.trim())
      if (envName) {
        out[id] = { configured: true, source: 'env', hint: this.env[envName]!.trim().slice(-4) }
      } else if (this.undecryptable.has(id)) {
        out[id] = {
          configured: false,
          source: 'stored',
          problem: 'A saved key exists but could not be decrypted (for example after changing Windows account). Please enter it again.'
        }
      } else {
        out[id] = { configured: false, source: 'none' }
      }
    }
    return out
  }
}
