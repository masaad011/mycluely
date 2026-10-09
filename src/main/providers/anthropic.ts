import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo } from '@shared/types'
import { sortModels } from '@shared/models'
import { isUnsupportedParamError, normalizeError, throwIfAborted } from './errors'
import type { ChatRequest, ChatResult, LlmProvider, ProviderConfig } from './types'

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

interface ModelCaps {
  effort: boolean
  vision: boolean
}

/**
 * Anthropic Claude via the official `@anthropic-ai/sdk`. Capabilities (vision, effort, context
 * window) come from the Models API, so new Claude models work without code changes.
 * Thinking is left at each model's default (adaptive on current models); latency is steered with
 * `output_config.effort` where the model supports it.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  private readonly client: Anthropic
  private readonly caps = new Map<string, ModelCaps>()
  private readonly noFallback = new Set<string>()

  constructor(cfg: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || undefined,
      timeout: cfg.timeoutMs ?? 90_000,
      maxRetries: 1
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const m of this.client.models.list({}, { signal })) {
        const caps = (m.capabilities ?? null) as Record<string, { supported?: boolean }> | null
        const vision = caps?.image_input?.supported ?? true
        const effort = caps?.effort?.supported ?? false
        this.caps.set(m.id, { vision, effort })
        out.push({
          id: m.id,
          provider: 'anthropic',
          displayName: m.display_name || m.id,
          contextWindow: m.max_input_tokens ?? undefined,
          maxOutputTokens: m.max_tokens ?? undefined,
          vision,
          visionSource: caps ? 'api' : 'heuristic',
          audioInput: false,
          createdAt: m.created_at ? Date.parse(m.created_at) : undefined
        })
      }
      return sortModels('anthropic', out)
    } catch (err) {
      throw normalizeError('anthropic', err)
    }
  }

  private async capsFor(model: string, signal: AbortSignal): Promise<ModelCaps> {
    const cached = this.caps.get(model)
    if (cached) return cached
    try {
      const m = await this.client.models.retrieve(model, {}, { signal })
      const caps = (m.capabilities ?? null) as Record<string, { supported?: boolean }> | null
      const value = { vision: caps?.image_input?.supported ?? true, effort: caps?.effort?.supported ?? false }
      this.caps.set(model, value)
      return value
    } catch {
      return { vision: true, effort: false }
    }
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    const caps = await this.capsFor(req.model, req.signal)
    const useFallback = FALLBACK_MODELS.test(req.model) && !this.noFallback.has(req.model)
    try {
      return await this.streamOnce(req, caps, useFallback)
    } catch (err) {
      const e = normalizeError('anthropic', err)
      if (useFallback && isUnsupportedParamError(e, 'fallback')) {
        this.noFallback.add(req.model)
        return this.streamOnce(req, caps, false).catch((e2) => {
          throw normalizeError('anthropic', e2)
        })
      }
      if (caps.effort && isUnsupportedParamError(e, 'effort', 'output_config')) {
        this.caps.set(req.model, { ...caps, effort: false })
        return this.streamOnce(req, { ...caps, effort: false }, useFallback).catch((e2) => {
          throw normalizeError('anthropic', e2)
        })
      }
      throw e
    }
  }

  private async streamOnce(req: ChatRequest, caps: ModelCaps, useFallback: boolean): Promise<ChatResult> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    if (req.image && caps.vision) {
      content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.base64 } })
    }
    content.push({ type: 'text', text: req.user })

    const stream = this.client.beta.messages.stream(
      {
        model: req.model,
        // Adaptive thinking (on by default for current Claude models) counts against max_tokens.
        max_tokens: req.maxOutputTokens + (req.effort === 'medium' ? 8000 : 2000),
        system: req.system,
        messages: [{ role: 'user', content }],
        // `low` is Claude's fastest effort level.
        ...(caps.effort ? { output_config: { effort: req.effort === 'minimal' ? 'low' : req.effort } } : {}),
        ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
      },
      { signal: req.signal, timeout: req.timeoutMs }
    )
    let text = ''
    stream.on('text', (delta) => {
      text += delta
      req.onDelta(delta)
    })
    const message = await stream.finalMessage()
    throwIfAborted('anthropic', req.signal)
    const notes: string[] = []
    if (message.model && message.model !== req.model) notes.push(`Answered by fallback model ${message.model}.`)
    if (message.stop_reason === 'refusal') {
      return { text, finish: 'refusal', servedBy: message.model, notes }
    }
    return {
      text,
      finish: message.stop_reason === 'max_tokens' ? 'length' : 'stop',
      servedBy: message.model,
      notes
    }
  }
}
