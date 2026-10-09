import OpenAI, { toFile } from 'openai'
import type { ModelInfo } from '@shared/types'
import { heuristicContextWindow, heuristicVision, isChatModel, sortModels } from '@shared/models'
import { isUnsupportedParamError, normalizeError } from './errors'
import { effortLadder, streamResponses, type Effort } from './responses-stream'
import type {
  ChatRequest,
  ChatResult,
  LlmProvider,
  ProviderConfig,
  SpeechToText,
  TranscribeRequest,
  TranscribeResult
} from './types'


/**
 * OpenAI via the official `openai` SDK. Chat uses the Responses API (OpenAI's recommended API
 * for new text apps) with `store: false` so meeting content is not retained server-side.
 * Transcription uses /v1/audio/transcriptions.
 */
export class OpenAIProvider implements LlmProvider, SpeechToText {
  readonly id = 'openai' as const
  private readonly client: OpenAI
  /** Per model and effort: the first `effortLadder` step the model accepts. */
  private readonly effortStep = new Map<string, number>()

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || undefined,
      timeout: cfg.timeoutMs ?? 90_000,
      maxRetries: 1
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const m of this.client.models.list({ signal })) {
        if (!isChatModel('openai', m.id)) continue
        out.push({
          id: m.id,
          provider: 'openai',
          displayName: m.id,
          contextWindow: heuristicContextWindow('openai', m.id),
          vision: heuristicVision('openai', m.id),
          visionSource: 'heuristic',
          audioInput: false,
          createdAt: m.created ? m.created * 1000 : undefined
        })
      }
      return sortModels('openai', out)
    } catch (err) {
      throw normalizeError('openai', err)
    }
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    const ladder = effortLadder(req.effort)
    const key = `${req.model}|${req.effort}`
    for (let step = this.effortStep.get(key) ?? 0; ; step++) {
      try {
        return await this.streamOnce(req, ladder[step])
      } catch (err) {
        const e = normalizeError('openai', err)
        // A model that rejects this reasoning value gets the next one (finally none at all).
        if (step < ladder.length - 1 && isUnsupportedParamError(e, 'reasoning', 'effort')) {
          this.effortStep.set(key, step + 1)
          continue
        }
        throw e
      }
    }
  }

  private streamOnce(req: ChatRequest, effort: Effort | undefined): Promise<ChatResult> {
    return streamResponses(this.client, req, { provider: 'openai', effort, sendImage: true })
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    try {
      const file = await toFile(Buffer.from(req.wav), 'segment.wav', { type: 'audio/wav' })
      const model = req.diarize ? 'gpt-4o-transcribe-diarize' : req.model
      if (model.includes('diarize')) {
        const res = (await this.client.audio.transcriptions.create(
          {
            file,
            model,
            response_format: 'diarized_json',
            chunking_strategy: 'auto',
            ...(req.language ? { language: req.language } : {})
          },
          { signal: req.signal }
        )) as unknown as {
          text: string
          segments?: { speaker?: string; text: string; start?: number; end?: number }[]
        }
        const parts = (res.segments ?? []).map((s) => ({
          text: s.text.trim(),
          speaker: s.speaker,
          startMs: s.start !== undefined ? s.start * 1000 : undefined,
          endMs: s.end !== undefined ? s.end * 1000 : undefined
        }))
        return { text: res.text ?? parts.map((p) => p.text).join(' '), parts: parts.length ? parts : [{ text: res.text }] }
      }
      const lang = req.language
        ? model === 'gpt-transcribe'
          ? { languages: [req.language] }
          : { language: req.language }
        : {}
      const prompt = req.prompt && model !== 'gpt-4o-transcribe-diarize' ? { prompt: req.prompt.slice(-800) } : {}
      const res = await this.client.audio.transcriptions.create(
        { file, model, response_format: 'json', ...lang, ...prompt },
        { signal: req.signal }
      )
      return { text: res.text, parts: [{ text: res.text }] }
    } catch (err) {
      throw normalizeError('openai', err)
    }
  }
}
