import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { encodeWav } from '@shared/audio/wav'
import type { ProviderId } from '@shared/types'
import { ProviderError } from '../../src/main/providers/errors'
import type { ProviderRegistry } from '../../src/main/providers/registry'
import type { SpeechToText, TranscribeRequest } from '../../src/main/providers/types'
import type { CaptureDriver } from '../../src/main/session/ports'
import { TranscriptionService, type TranscriptionStatusUpdate } from '../../src/main/transcription/service'

const wav = (seconds: number): Uint8Array => encodeWav(new Float32Array(16000 * seconds).fill(0.1), 16000)

function setup(opts: {
  engine: Settings['transcription']['engine']
  configured?: ProviderId[]
  stt?: (req: TranscribeRequest, call: number) => Promise<string>
  local?: () => Promise<string>
}) {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.transcription.engine = opts.engine
  let calls = 0
  const requests: TranscribeRequest[] = []
  const stt: SpeechToText = {
    async transcribe(req) {
      requests.push(req)
      const text = await (opts.stt ?? (async () => 'cloud text'))(req, ++calls)
      return { text, parts: [{ text }] }
    }
  }
  const registry = {
    isConfigured: async (id: ProviderId) => (opts.configured ?? []).includes(id),
    speechToText: async () => stt
  } as unknown as ProviderRegistry
  let localCalls = 0
  const capture = {
    command: () => undefined,
    grab: async () => ({ requestId: '', ok: false }),
    localTranscribe: async () => {
      localCalls++
      return (opts.local ?? (async () => 'local text'))()
    }
  } as unknown as CaptureDriver
  const statuses: TranscriptionStatusUpdate[] = []
  const notices: string[] = []
  const svc = new TranscriptionService(registry, () => settings, capture, (s) => statuses.push(s), (m) => notices.push(m))
  return { svc, requests, statuses, notices, localCalls: () => localCalls }
}

const job = (i: number, source: 'mic' | 'system' = 'system') => ({
  id: `j${i}`,
  source,
  startMs: i * 3000,
  at: i * 3000,
  durationMs: 2000,
  wav: wav(2)
})

describe('transcription service', () => {
  it('auto mode prefers OpenAI, then Gemini, then on-device Whisper', async () => {
    expect((await setup({ engine: 'auto', configured: ['openai', 'gemini'] }).svc.resolveEngine()).engine).toBe('openai')
    expect((await setup({ engine: 'auto', configured: ['gemini'] }).svc.resolveEngine()).engine).toBe('gemini')
    expect((await setup({ engine: 'auto', configured: ['anthropic'] }).svc.resolveEngine()).engine).toBe('local')
  })

  it('retries transient failures and reports success', async () => {
    const t = setup({
      engine: 'openai',
      configured: ['openai'],
      stt: async (_req, call) => {
        if (call === 1) throw new ProviderError('openai', 'server', 'boom', 503, 10)
        return 'recovered'
      }
    })
    const out = await t.svc.enqueue(job(1))
    expect(out.result?.text).toBe('recovered')
    expect(t.requests).toHaveLength(2)
    expect(t.statuses.at(-1)?.ok).toBe(true)
  })

  it('falls back to on-device Whisper when the auto-selected cloud engine fails permanently', async () => {
    const t = setup({
      engine: 'auto',
      configured: ['openai'],
      stt: async () => {
        throw new ProviderError('openai', 'quota', 'You exceeded your current quota', 429)
      }
    })
    const out = await t.svc.enqueue(job(1))
    expect(out.result?.text).toBe('local text')
    expect(t.localCalls()).toBe(1)
    expect(t.notices[0]).toMatch(/on-device Whisper/)
    expect((await t.svc.resolveEngine()).engine).toBe('local')
    t.svc.reset()
    expect((await t.svc.resolveEngine()).engine).toBe('openai')
  })

  it('reports permanent errors for an explicitly chosen engine without falling back', async () => {
    const t = setup({
      engine: 'openai',
      configured: ['openai'],
      stt: async () => {
        throw new ProviderError('openai', 'auth', 'bad key', 401)
      }
    })
    const out = await t.svc.enqueue(job(1))
    expect(out.error).toMatch(/API key was rejected/)
    expect(t.localCalls()).toBe(0)
    expect(t.statuses.at(-1)).toMatchObject({ ok: false })
  })

  it('merges a backlog of queued segments from the same speaker instead of dropping audio', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({
      engine: 'openai',
      configured: ['openai'],
      stt: async () => {
        await gate
        return 'text'
      }
    })
    const outcomes = Array.from({ length: 12 }, (_, i) => t.svc.enqueue(job(i)))
    // Two run immediately; the other ten queue up and get merged.
    await new Promise((r) => setTimeout(r, 20))
    release()
    const results = await Promise.all(outcomes)
    const merged = results.filter((r) => r.error === 'merged').length
    expect(merged).toBeGreaterThan(0)
    expect(t.requests.length).toBe(12 - merged)
    expect(t.requests.some((r) => r.durationMs > 2000)).toBe(true)
    expect(results.filter((r) => r.result).every((r) => r.result!.text === 'text')).toBe(true)
  })

  it('cancels queued and in-flight work on reset (new meeting)', async () => {
    const t = setup({
      engine: 'openai',
      configured: ['openai'],
      stt: (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })))
        })
    })
    const inflight = t.svc.enqueue(job(1))
    const queued = [t.svc.enqueue(job(2)), t.svc.enqueue(job(3))]
    await new Promise((r) => setTimeout(r, 20))
    t.svc.reset()
    expect((await inflight).error).toBe('cancelled')
    for (const q of queued) expect((await q).error).toBe('cancelled')
    expect(t.svc.pending).toBe(0)
  })
})
