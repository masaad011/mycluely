import type { ModelInfo, ProviderId, ProviderTestResult } from '@shared/types'
import type { Settings } from '@shared/settings'
import { RECOMMENDED_MODELS } from '@shared/models'
import { CHATGPT_RESOURCE, type ChatGPTAuth } from '../services/chatgpt-auth'
import { warmConnection } from '../services/network'
import { AnthropicProvider } from './anthropic'
import { ChatGPTPlanProvider } from './chatgpt'
import { DEEPSEEK_BASE_URL, DeepSeekProvider } from './deepseek'
import { ProviderError, normalizeError } from './errors'
import { GeminiProvider } from './gemini'
import { MOONSHOT_BASE_URLS, MoonshotProvider } from './moonshot'
import { OpenAIProvider } from './openai'
import type { LlmProvider, SpeechToText } from './types'

export type KeyResolver = (id: ProviderId) => Promise<string | undefined>

type AnyProvider = LlmProvider & Partial<SpeechToText>

const MODEL_TTL_MS = 10 * 60_000

/**
 * Creates provider clients on demand from the current settings and credentials, caches them per
 * (key, base URL) and caches model lists. Changing a key or base URL transparently creates a new
 * client, which is what lets the user switch provider/model mid-meeting.
 */
export class ProviderRegistry {
  private clients = new Map<string, AnyProvider>()
  private models = new Map<ProviderId, { at: number; list: ModelInfo[] }>()
  private readonly refreshing = new Set<ProviderId>()

  constructor(
    private readonly getKey: KeyResolver,
    private readonly getSettings: () => Settings,
    /** "Sign in with ChatGPT" session (the `chatgpt` provider); optional so tests can omit it. */
    private readonly chatgpt?: ChatGPTAuth,
    private readonly chatgptBaseURL?: string
  ) {}

  async isConfigured(id: ProviderId): Promise<boolean> {
    if (id === 'chatgpt') return !!this.chatgpt?.credentialStatus().configured
    return !!(await this.getKey(id))
  }

  async get(id: ProviderId): Promise<AnyProvider> {
    if (id === 'chatgpt') return this.getChatGPT()
    const key = await this.getKey(id)
    if (!key) throw new ProviderError(id, 'not_configured', 'No API key configured')
    const s = this.getSettings()
    const baseURL = s.ai.baseUrls[id]
    const timeoutMs = s.ai.requestTimeoutSec * 1000
    const cacheKey = `${id}|${key}|${baseURL ?? ''}|${id === 'moonshot' ? s.ai.moonshotRegion : ''}|${timeoutMs}`
    const existing = this.clients.get(cacheKey)
    if (existing) return existing
    // Drop stale clients for this provider (old key/base URL).
    for (const k of this.clients.keys()) if (k.startsWith(`${id}|`)) this.clients.delete(k)
    let client: AnyProvider
    switch (id) {
      case 'openai':
        client = new OpenAIProvider({ apiKey: key, baseURL, timeoutMs })
        break
      case 'anthropic':
        client = new AnthropicProvider({ apiKey: key, baseURL, timeoutMs })
        break
      case 'gemini':
        client = new GeminiProvider({ apiKey: key, baseURL, timeoutMs })
        break
      case 'moonshot':
        client = new MoonshotProvider({ apiKey: key, baseURL, timeoutMs, region: s.ai.moonshotRegion })
        break
      case 'deepseek':
        client = new DeepSeekProvider({ apiKey: key, baseURL, timeoutMs })
        break
      default:
        throw new ProviderError(id, 'not_configured', 'Unknown provider')
    }
    this.clients.set(cacheKey, client)
    this.models.delete(id)
    return client
  }

  private getChatGPT(): AnyProvider {
    const status = this.chatgpt?.credentialStatus()
    if (!this.chatgpt || !status?.configured) {
      throw new ProviderError('chatgpt', 'not_configured', 'Not signed in', undefined, undefined, undefined,
        status?.problem
          ? `ChatGPT plan: ${status.problem}`
          : 'ChatGPT plan is not connected. Use “Continue with ChatGPT” in Settings → API keys & providers.')
    }
    const timeoutMs = this.getSettings().ai.requestTimeoutSec * 1000
    // Tokens are fetched (and refreshed) per request, so one client per account is enough.
    const cacheKey = `chatgpt|${status.account ?? ''}|${timeoutMs}`
    let client = this.clients.get(cacheKey)
    if (!client) {
      for (const k of this.clients.keys()) if (k.startsWith('chatgpt|')) this.clients.delete(k)
      client = new ChatGPTPlanProvider(this.chatgpt, { baseURL: this.chatgptBaseURL, timeoutMs })
      this.clients.set(cacheKey, client)
      this.models.delete('chatgpt')
    }
    return client
  }

  async speechToText(id: 'openai' | 'gemini'): Promise<SpeechToText> {
    const p = await this.get(id)
    if (!p.transcribe) throw new ProviderError(id, 'unsupported', 'This provider cannot transcribe audio')
    return p as SpeechToText
  }

  /** Invalidate clients/model caches (after key or base URL changes). */
  reset(id?: ProviderId): void {
    for (const k of [...this.clients.keys()]) if (!id || k.startsWith(`${id}|`)) this.clients.delete(k)
    if (id) this.models.delete(id)
    else this.models.clear()
  }

  async listModels(id: ProviderId, refresh = false, signal?: AbortSignal): Promise<ModelInfo[]> {
    const cached = this.models.get(id)
    if (!refresh && cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.list
    const client = await this.get(id)
    const list = await client.listModels(signal)
    this.models.set(id, { at: Date.now(), list })
    return list
  }

  cachedModel(id: ProviderId, model: string): ModelInfo | undefined {
    return this.models.get(id)?.list.find((m) => m.id === model)
  }

  /**
   * Model metadata for a request. Never waits on the network: a cache miss starts a background
   * refresh and the caller falls back to heuristics, so an answer is never delayed by a model-list
   * download.
   */
  async modelInfo(id: ProviderId, model: string): Promise<ModelInfo | undefined> {
    const hit = this.cachedModel(id, model)
    if (hit) return hit
    if (!this.models.has(id) && !this.refreshing.has(id)) {
      this.refreshing.add(id)
      void this.listModels(id, false, AbortSignal.timeout(20_000))
        .catch(() => undefined)
        .finally(() => this.refreshing.delete(id))
    }
    return undefined
  }

  /** Open a connection to the provider ahead of a likely request (see warmConnection). */
  warm(id: ProviderId): void {
    const s = this.getSettings()
    const defaults: Record<ProviderId, string> = {
      chatgpt: this.chatgptBaseURL ?? CHATGPT_RESOURCE,
      openai: 'https://api.openai.com',
      anthropic: 'https://api.anthropic.com',
      gemini: 'https://generativelanguage.googleapis.com',
      moonshot: MOONSHOT_BASE_URLS[s.ai.moonshotRegion],
      deepseek: DEEPSEEK_BASE_URL
    }
    try {
      warmConnection(new URL((id !== 'chatgpt' && s.ai.baseUrls[id]) || defaults[id]).origin)
    } catch {
      // Malformed custom base URL: nothing to warm.
    }
  }

  async test(id: ProviderId): Promise<ProviderTestResult> {
    const started = Date.now()
    try {
      const list = await this.listModels(id, true, AbortSignal.timeout(20_000))
      const latencyMs = Date.now() - started
      const selected = this.getSettings().ai.models[id]
      const hasSelected = list.some((m) => m.id === selected)
      const rec = RECOMMENDED_MODELS[id].find((r) => list.some((m) => m.id === r))
      let message = `Connected in ${latencyMs} ms — ${list.length} chat model${list.length === 1 ? '' : 's'} available${id === 'chatgpt' ? ' with your ChatGPT plan' : ''}.`
      if (!hasSelected) {
        message += ` Selected model "${selected}" was not found${rec ? `; "${rec}" is available` : ''}.`
      }
      return { ok: true, latencyMs, modelCount: list.length, message }
    } catch (err) {
      const e = normalizeError(id, err)
      return { ok: false, message: e.userMessage }
    }
  }
}
