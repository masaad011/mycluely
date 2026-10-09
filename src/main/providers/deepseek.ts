import OpenAI from 'openai'
import type { ModelInfo } from '@shared/types'
import { heuristicContextWindow, heuristicVision, isChatModel, sortModels, type Effort } from '@shared/models'
import { streamChatCompletions } from './chat-completions-stream'
import { isUnsupportedParamError, normalizeError } from './errors'
import type { ChatRequest, ChatResult, LlmProvider, ProviderConfig } from './types'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

interface DeepSeekModel {
  id: string
  name?: string
  created?: number
  context_window?: number
  max_output_tokens?: number
  input_modalities?: string[]
}

/**
 * DeepSeek through its official OpenAI-compatible Chat Completions API (api.deepseek.com), using
 * the OpenAI SDK with DeepSeek's base URL as DeepSeek documents. The model list reports context
 * window and image support. DeepSeek thinks by default; quick answers turn thinking off for
 * latency, detailed ones keep it on at low effort. Reasoning text is never shown.
 */
export class DeepSeekProvider implements LlmProvider {
  readonly id = 'deepseek' as const
  private readonly client: OpenAI
  private readonly dropExtras = new Set<string>()
  /** Models that rejected image input (only some DeepSeek models accept images). */
  private readonly noImages = new Set<string>()

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || DEEPSEEK_BASE_URL,
      timeout: cfg.timeoutMs ?? 90_000,
      maxRetries: 1
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const raw of this.client.models.list({ signal })) {
        const m = raw as unknown as DeepSeekModel
        if (!isChatModel('deepseek', m.id)) continue
        const hasModalities = Array.isArray(m.input_modalities)
        out.push({
          id: m.id,
          provider: 'deepseek',
          displayName: m.name || m.id,
          contextWindow: m.context_window ?? heuristicContextWindow('deepseek', m.id),
          maxOutputTokens: m.max_output_tokens,
          vision: hasModalities ? m.input_modalities!.includes('image') : heuristicVision('deepseek', m.id),
          visionSource: hasModalities ? 'api' : 'heuristic',
          audioInput: false,
          createdAt: m.created ? m.created * 1000 : undefined
        })
      }
      return sortModels('deepseek', out)
    } catch (err) {
      throw normalizeError('deepseek', err)
    }
  }

  /** Thinking off for quick answers; on with low effort for detailed/technical ones. */
  private extras(model: string, effort: Effort): Record<string, unknown> {
    if (this.dropExtras.has(model)) return {}
    return effort === 'medium' ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' } : { thinking: { type: 'disabled' } }
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    const notes: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await streamChatCompletions(this.client, req, {
          provider: 'deepseek',
          sendImage: !this.noImages.has(req.model),
          maxTokensField: 'max_tokens',
          maxTokens: req.maxOutputTokens + (req.effort === 'medium' ? 8000 : 0),
          extras: this.extras(req.model, req.effort)
        })
        return { ...result, notes: [...(result.notes ?? []), ...notes] }
      } catch (err) {
        const e = normalizeError('deepseek', err)
        if (req.image && !this.noImages.has(req.model) && isUnsupportedParamError(e, 'image')) {
          this.noImages.add(req.model)
          notes.push('This DeepSeek model doesn’t accept screenshots — used screen text only.')
          continue
        }
        if (!this.dropExtras.has(req.model) && isUnsupportedParamError(e, 'thinking', 'reasoning_effort', 'reasoning')) {
          this.dropExtras.add(req.model)
          continue
        }
        throw e
      }
    }
    throw normalizeError('deepseek', new Error('DeepSeek request could not be completed'))
  }
}
