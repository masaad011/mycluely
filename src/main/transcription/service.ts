import type { Settings } from '@shared/settings'
import type { TranscriptionEngineId } from '@shared/types'
import { concatWavs } from '@shared/audio/wav'
import { sleep } from '@shared/util'
import type { ProviderRegistry } from '../providers/registry'
import { ProviderError, normalizeError } from '../providers/errors'
import type { TranscribeResult } from '../providers/types'
import type { CaptureDriver } from '../session/ports'

export interface TranscriptionJob {
  id: string
  source: 'mic' | 'system'
  /** ms since meeting start */
  startMs: number
  at: number
  durationMs: number
  wav: Uint8Array
  /** Recent transcript for continuity hints. */
  context?: string
  /** Several queued segments combined into one request (backlog relief). */
  merged?: boolean
}

export interface TranscriptionOutcome {
  job: TranscriptionJob
  result?: TranscribeResult
  error?: string
}

export interface TranscriptionStatusUpdate {
  engine: TranscriptionEngineId
  model: string
  pending: number
  ok: boolean
  error?: string
}

type Resolved = { engine: 'openai' | 'gemini' | 'local' | 'none'; model: string }

function describeFailure(
  engine: Resolved['engine'],
  err: unknown
): { message: string; retryable: boolean; retryAfterMs?: number } {
  if (engine === 'local' || engine === 'none') {
    const msg = err instanceof Error ? err.message : String(err)
    return { message: `On-device Whisper: ${msg}`, retryable: /network|fetch|timed? ?out|busy/i.test(msg) }
  }
  const e = normalizeError(engine, err)
  return { message: e.userMessage, retryable: e.retryable, retryAfterMs: e.retryAfterMs }
}

const MAX_ATTEMPTS = 3
const CONCURRENCY = 2
const MERGE_BACKLOG = 6
const MERGE_MAX_MS = 28_000

/**
 * Turns audio segments into text with the configured engine. Keeps up during long meetings by
 * running two requests at a time and, when the backlog grows (slow network, rate limits), merging
 * queued segments from the same speaker into fewer, longer requests instead of dropping audio.
 */
export class TranscriptionService {
  private queue: { job: TranscriptionJob; resolve: (o: TranscriptionOutcome) => void }[] = []
  private running = 0
  private controller = new AbortController()
  /** Set when the auto-selected cloud engine fails permanently; we fall back to local Whisper. */
  private autoFallbackToLocal = false
  private lastError?: string

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly settings: () => Settings,
    private readonly capture: CaptureDriver,
    private readonly onStatus: (s: TranscriptionStatusUpdate) => void,
    private readonly onNotice: (message: string) => void = () => undefined
  ) {}

  get pending(): number {
    return this.queue.length + this.running
  }

  async resolveEngine(): Promise<Resolved> {
    const t = this.settings().transcription
    switch (t.engine) {
      case 'none':
        return { engine: 'none', model: '' }
      case 'local':
        return { engine: 'local', model: t.localModel }
      case 'openai':
        return { engine: 'openai', model: t.openaiModel }
      case 'gemini':
        return { engine: 'gemini', model: t.geminiModel }
      case 'auto':
        if (this.autoFallbackToLocal) return { engine: 'local', model: t.localModel }
        if (await this.registry.isConfigured('openai')) return { engine: 'openai', model: t.openaiModel }
        if (await this.registry.isConfigured('gemini')) return { engine: 'gemini', model: t.geminiModel }
        return { engine: 'local', model: t.localModel }
    }
  }

  /** Reset per-meeting state (fallbacks, errors) and cancel anything in flight. */
  reset(): void {
    this.controller.abort()
    this.controller = new AbortController()
    for (const q of this.queue) q.resolve({ job: q.job, error: 'cancelled' })
    this.queue = []
    this.autoFallbackToLocal = false
    this.lastError = undefined
    void this.publish()
  }

  enqueue(job: TranscriptionJob): Promise<TranscriptionOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve })
      this.mergeBacklog()
      void this.publish()
      this.pump()
    })
  }

  private mergeBacklog(): void {
    if (this.queue.length <= MERGE_BACKLOG) return
    const merged: typeof this.queue = []
    for (const item of this.queue) {
      const prev = merged[merged.length - 1]
      if (
        prev &&
        prev.job.source === item.job.source &&
        prev.job.durationMs + item.job.durationMs <= MERGE_MAX_MS
      ) {
        const a = prev.job
        const b = item.job
        const job: TranscriptionJob = {
          ...a,
          // Spans the real meeting time; the merged audio itself has the gaps shortened.
          durationMs: b.startMs + b.durationMs - a.startMs,
          wav: concatWavs([a.wav, b.wav]),
          context: a.context,
          merged: true
        }
        const resolveA = prev.resolve
        const resolveB = item.resolve
        merged[merged.length - 1] = {
          job,
          // The outcome carries the job that was actually transcribed (the full merge).
          resolve: (o) => {
            resolveA(o)
            resolveB({ job: b, error: 'merged' })
          }
        }
      } else {
        merged.push(item)
      }
    }
    this.queue = merged
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const item = this.queue.shift()!
      this.running++
      void this.process(item.job)
        .then(item.resolve)
        .finally(() => {
          this.running--
          void this.publish()
          this.pump()
        })
    }
  }

  private async process(job: TranscriptionJob): Promise<TranscriptionOutcome> {
    const signal = this.controller.signal
    for (let attempt = 1; ; attempt++) {
      const resolved = await this.resolveEngine()
      if (resolved.engine === 'none') return { job, error: 'Transcription is turned off' }
      try {
        const result = await this.run(resolved, job, signal)
        if (this.lastError) {
          this.lastError = undefined
          void this.publish()
        }
        return { job, result }
      } catch (err) {
        if (signal.aborted) return { job, error: 'cancelled' }
        const e = describeFailure(resolved.engine, err)
        const message = e.message
        // Auto mode: a permanently failing cloud engine falls back to on-device Whisper.
        if (
          this.settings().transcription.engine === 'auto' &&
          resolved.engine !== 'local' &&
          !e.retryable
        ) {
          this.autoFallbackToLocal = true
          this.onNotice(`${message} Switching transcription to on-device Whisper.`)
          continue
        }
        if (e.retryable && attempt < MAX_ATTEMPTS) {
          this.lastError = message
          void this.publish()
          await sleep(e.retryAfterMs ?? 1500 * 2 ** (attempt - 1), signal).catch(() => undefined)
          if (signal.aborted) return { job, error: 'cancelled' }
          continue
        }
        this.lastError = message
        void this.publish()
        return { job, error: message }
      }
    }
  }

  private async run(resolved: Resolved, job: TranscriptionJob, signal: AbortSignal): Promise<TranscribeResult> {
    const t = this.settings().transcription
    const language = t.language || undefined
    if (resolved.engine === 'local') {
      const text = await this.capture.localTranscribe(
        { model: resolved.model, language: resolved.model.endsWith('.en') ? undefined : language, wav: job.wav },
        signal
      )
      return { text, parts: [{ text }] }
    }
    if (resolved.engine === 'none') throw new Error('Transcription is turned off')
    const stt = await this.registry.speechToText(resolved.engine)
    const timeoutMs = Math.max(45_000, job.durationMs * 4)
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await stt.transcribe({
        wav: job.wav,
        durationMs: job.durationMs,
        model: resolved.model,
        language,
        prompt: job.context,
        diarize: resolved.engine === 'openai' && t.diarize && job.source === 'system',
        signal: AbortSignal.any([signal, timeout])
      })
    } catch (err) {
      // Our own deadline is a (retryable) timeout, not a user cancellation.
      if (timeout.aborted && !signal.aborted) {
        throw new ProviderError(resolved.engine, 'timeout', `Transcription took longer than ${Math.round(timeoutMs / 1000)} s`)
      }
      throw err
    }
  }

  /** Coalesces status updates: at most one in flight, and the latest state always wins. */
  async publish(): Promise<void> {
    if (this.publishing) {
      this.publishDirty = true
      return
    }
    this.publishing = true
    try {
      do {
        this.publishDirty = false
        await this.publishNow()
      } while (this.publishDirty)
    } finally {
      this.publishing = false
    }
  }

  private publishing = false
  private publishDirty = false

  private async publishNow(): Promise<void> {
    const r = await this.resolveEngine()
    this.onStatus({
      engine: r.engine === 'none' ? 'none' : r.engine,
      model: r.model,
      pending: this.pending,
      ok: !this.lastError,
      error: this.lastError
    })
  }
}
