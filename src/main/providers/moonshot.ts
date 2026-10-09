import OpenAI from 'openai'
import type { ModelInfo } from '@shared/types'
import { heuristicContextWindow, heuristicVision, isChatModel, sortModels, type Effort } from '@shared/models'
import { streamChatCompletions } from './chat-completions-stream'
import { isUnsupportedParamError, normalizeError } from './errors'
import type { ChatRequest, ChatResult, LlmProvider, ProviderConfig } from './types'

export const MOONSHOT_BASE_URLS = {
  global: 'https://api.moonshot.ai/v1',
  cn: 'https://api.moonshot.cn/v1'
} as const

interface KimiModel {
  id: string
  created?: number
  context_length?: number
  supports_image_in?: boolean
  supports_reasoning?: boolean
}

/**
 * Moonshot AI (Kimi) through its official OpenAI-compatible Chat Completions endpoint, using
 * the OpenAI SDK as Moonshot's documentation recommends. Kimi fixes sampling parameters
 * (temperature, top_p, …) and rejects other values, so none are sent. Reasoning is controlled per
 * model family: `thinking` on K2.x, `reasoning_effort` on K3.
 */
export class MoonshotProvider implements LlmProvider {
  readonly id = 'moonshot' as const
  private readonly client: OpenAI
  private readonly dropExtras = new Set<string>()
  /** Models that only accept the legacy `max_tokens` parameter. */
  private readonly legacyMaxTokens = new Set<string>()

  constructor(cfg: ProviderConfig & { region?: 'global' | 'cn' }) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || MOONSHOT_BASE_URLS[cfg.region ?? 'global'],
      timeout: cfg.timeoutMs ?? 90_000,
      maxRetries: 1
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const raw of this.client.models.list({ signal })) {
        const m = raw as unknown as KimiModel
        if (!isChatModel('moonshot', m.id)) continue
        const hasFlag = typeof m.supports_image_in === 'boolean'
        out.push({
          id: m.id,
          provider: 'moonshot',
          displayName: m.id,
          contextWindow: m.context_length ?? heuristicContextWindow('moonshot', m.id),
          vision: hasFlag ? !!m.supports_image_in : heuristicVision('moonshot', m.id),
          visionSource: hasFlag ? 'api' : 'heuristic',
          audioInput: false,
          createdAt: m.created ? m.created * 1000 : undefined
        })
      }
      return sortModels('moonshot', out)
    } catch (err) {
      throw normalizeError('moonshot', err)
    }
  }

  /** Model-specific reasoning controls (not part of the OpenAI types). */
  private extras(model: string, effort: Effort): Record<string, unknown> {
    if (this.dropExtras.has(model)) return {}
    const m = model.toLowerCase()
    if (/^kimi-k3/.test(m)) return { reasoning_effort: effort === 'medium' ? 'high' : 'low' }
    if (/^kimi-k2\.\d/.test(m) && !m.includes('code')) {
      return { thinking: { type: effort === 'medium' ? 'enabled' : 'disabled' } }
    }
    return {}
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    try {
      return await this.streamOnce(req)
    } catch (err) {
      const e = normalizeError('moonshot', err)
      if (!this.dropExtras.has(req.model) && isUnsupportedParamError(e, 'thinking', 'reasoning_effort', 'reasoning')) {
        this.dropExtras.add(req.model)
        return this.streamOnce(req).catch((e2) => {
          throw normalizeError('moonshot', e2)
        })
      }
      if (!this.legacyMaxTokens.has(req.model) && isUnsupportedParamError(e, 'max_completion_tokens')) {
        this.legacyMaxTokens.add(req.model)
        return this.streamOnce(req).catch((e2) => {
          throw normalizeError('moonshot', e2)
        })
      }
      throw e
    }
  }

  private streamOnce(req: ChatRequest): Promise<ChatResult> {
    return streamChatCompletions(this.client, req, {
      provider: 'moonshot',
      sendImage: true,
      maxTokensField: this.legacyMaxTokens.has(req.model) ? 'max_tokens' : 'max_completion_tokens',
      maxTokens: req.maxOutputTokens + (req.effort === 'medium' ? 8000 : 2000),
      extras: this.extras(req.model, req.effort)
    })
  }
}
