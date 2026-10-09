import { GoogleGenAI, ThinkingLevel, type GenerateContentConfig, type Part } from '@google/genai'
import type { ModelInfo } from '@shared/types'
import { heuristicVision, isChatModel, sortModels } from '@shared/models'
import { normalizeError, type ProviderError, throwIfAborted } from './errors'
import type {
  ChatRequest,
  ChatResult,
  LlmProvider,
  ProviderConfig,
  SpeechToText,
  TranscribeRequest,
  TranscribeResult
} from './types'

const TRANSCRIBE_INSTRUCTION =
  'Transcribe the speech in this audio verbatim in its original language. Output only the transcript text, with punctuation. ' +
  'Do not translate, summarize, describe sounds or add labels. If there is no intelligible speech, output nothing.'

/**
 * Google Gemini via the official `@google/genai` SDK (Gemini Developer API, generateContent).
 * Gemini models take image and audio input, so Gemini can also be the transcription engine.
 * Gemini 3.x thinking is controlled with `thinkingLevel`; the lowest accepted level differs by
 * model, so we step up (MINIMAL → LOW → omit) when a level is rejected and remember it.
 */
export class GeminiProvider implements LlmProvider, SpeechToText {
  readonly id = 'gemini' as const
  private readonly ai: GoogleGenAI
  /** Thinking levels a model has rejected; never sent to that model again. */
  private readonly rejectedLevels = new Map<string, Set<ThinkingLevel>>()

  constructor(cfg: ProviderConfig) {
    this.ai = new GoogleGenAI({
      apiKey: cfg.apiKey,
      httpOptions: {
        ...(cfg.baseURL ? { baseUrl: cfg.baseURL } : {}),
        timeout: cfg.timeoutMs ?? 90_000
      }
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      const pager = await this.ai.models.list({ config: { pageSize: 100, abortSignal: signal } })
      for await (const m of pager) {
        const id = (m.name ?? '').replace(/^models\//, '')
        if (!id || !isChatModel('gemini', id)) continue
        const actions = m.supportedActions ?? []
        if (actions.length && !actions.includes('generateContent')) continue
        out.push({
          id,
          provider: 'gemini',
          displayName: m.displayName || id,
          contextWindow: m.inputTokenLimit ?? undefined,
          maxOutputTokens: m.outputTokenLimit ?? undefined,
          vision: heuristicVision('gemini', id),
          visionSource: 'heuristic',
          audioInput: true
        })
      }
      return sortModels('gemini', out)
    } catch (err) {
      throw normalizeError('gemini', err)
    }
  }

  private levelsFor(model: string, desired: ThinkingLevel): (ThinkingLevel | null)[] {
    const ladder: (ThinkingLevel | null)[] =
      desired === ThinkingLevel.MINIMAL
        ? [ThinkingLevel.MINIMAL, ThinkingLevel.LOW, null]
        : desired === ThinkingLevel.LOW
          ? [ThinkingLevel.LOW, null]
          : [desired, ThinkingLevel.LOW, null]
    const rejected = this.rejectedLevels.get(model)
    return ladder.filter((l) => l === null || !rejected?.has(l))
  }

  /** Run `fn` with the first thinking level the model accepts. */
  private async withThinking<T>(
    model: string,
    desired: ThinkingLevel,
    fn: (level: ThinkingLevel | null) => Promise<T>
  ): Promise<T> {
    let lastErr: ProviderError | undefined
    for (const level of this.levelsFor(model, desired)) {
      try {
        return await fn(level)
      } catch (err) {
        const e = normalizeError('gemini', err)
        const m = e.message.toLowerCase()
        if (level !== null && e.kind === 'bad_request' && (m.includes('thinking') || m.includes('budget') || m.includes('level'))) {
          if (!this.rejectedLevels.has(model)) this.rejectedLevels.set(model, new Set())
          this.rejectedLevels.get(model)!.add(level)
          lastErr = e
          continue
        }
        throw e
      }
    }
    throw lastErr ?? new Error('Gemini rejected all thinking levels')
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    const parts: Part[] = [{ text: req.user }]
    if (req.image) parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.base64 } })
    const desired = req.effort === 'medium' ? ThinkingLevel.MEDIUM : req.effort === 'low' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL
    let emitted = false
    return this.withThinking(req.model, desired, async (level) => {
      if (emitted) throw new Error('stream already started')
      const config: GenerateContentConfig = {
        systemInstruction: req.system,
        maxOutputTokens: req.maxOutputTokens + (level === ThinkingLevel.MEDIUM ? 8000 : 2000),
        abortSignal: req.signal,
        ...(level ? { thinkingConfig: { thinkingLevel: level } } : {})
      }
      const stream = await this.ai.models.generateContentStream({
        model: req.model,
        contents: [{ role: 'user', parts }],
        config
      })
      let text = ''
      let finish: ChatResult['finish'] = 'stop'
      for await (const chunk of stream) {
        const delta = chunk.text
        if (delta) {
          emitted = true
          text += delta
          req.onDelta(delta)
        }
        const reason = chunk.candidates?.[0]?.finishReason
        if (reason === 'MAX_TOKENS') finish = 'length'
        else if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') finish = 'refusal'
        if (chunk.promptFeedback?.blockReason) finish = 'refusal'
      }
      throwIfAborted('gemini', req.signal)
      return { text, finish }
    })
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const instruction = req.language
      ? `${TRANSCRIBE_INSTRUCTION} The expected language is "${req.language}".`
      : TRANSCRIBE_INSTRUCTION
    const context = req.prompt ? `\nPrevious transcript for context (do not repeat it): ${req.prompt.slice(-500)}` : ''
    return this.withThinking(req.model, ThinkingLevel.MINIMAL, async (level) => {
      const res = await this.ai.models.generateContent({
        model: req.model,
        contents: [
          {
            role: 'user',
            parts: [
              { text: instruction + context },
              { inlineData: { mimeType: 'audio/wav', data: Buffer.from(req.wav).toString('base64') } }
            ]
          }
        ],
        config: {
          maxOutputTokens: 2048,
          abortSignal: req.signal,
          ...(level ? { thinkingConfig: { thinkingLevel: level } } : {})
        }
      })
      const text = (res.text ?? '').trim()
      return { text, parts: [{ text }] }
    })
  }
}
