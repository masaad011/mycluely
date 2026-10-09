import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../../src/main/providers/anthropic'
import { DeepSeekProvider } from '../../src/main/providers/deepseek'
import { GeminiProvider } from '../../src/main/providers/gemini'
import { MoonshotProvider } from '../../src/main/providers/moonshot'
import { OpenAIProvider } from '../../src/main/providers/openai'
import { ProviderRegistry } from '../../src/main/providers/registry'
import { sanitizeSettings } from '../../src/main/services/settings-schema'
import type { ChatRequest } from '../../src/main/providers/types'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockProviders()
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => {
  mock.requests.length = 0
  mock.options = {}
})

const IMAGE = { mimeType: 'image/jpeg' as const, base64: Buffer.from('fake-jpeg').toString('base64') }

function chat(over: Partial<ChatRequest> = {}): ChatRequest & { deltas: string[] } {
  const deltas: string[] = []
  return {
    model: 'm',
    system: 'SYSTEM PROMPT',
    user: 'Draft the answer the user can give.',
    maxOutputTokens: 512,
    effort: 'low',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    onDelta: (d) => deltas.push(d),
    deltas,
    ...over
  }
}

const EXPECTED = 'We publish change events from the database and the cache evicts affected keys within about a second.'

describe('Provider registry', () => {
  it('never makes a request wait for the model list', async () => {
    const settings = sanitizeSettings({ ai: { baseUrls: { openai: `${mock.url}/openai/v1` } } })
    const registry = new ProviderRegistry(async () => 'sk-test', () => settings)
    // Cold cache: no metadata yet (the caller uses heuristics), and a background refresh starts.
    expect(await registry.modelInfo('openai', 'gpt-6.1-sol')).toBeUndefined()
    await vi.waitFor(() => expect(registry.cachedModel('openai', 'gpt-6.1-sol')).toBeDefined())
    expect(mock.requests.filter((r) => r.path.endsWith('/models'))).toHaveLength(1)
  })
})

describe('OpenAI provider (Responses API)', () => {
  const p = (): OpenAIProvider => new OpenAIProvider({ apiKey: 'sk-test', baseURL: `${mock.url}/openai/v1` })

  it('lists chat models only, recommended first', async () => {
    const models = await p().listModels()
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-4o'])
    expect(models[0]).toMatchObject({ vision: true, contextWindow: 1_050_000 })
  })

  it('streams text and sends instructions, image, store:false and reasoning effort', async () => {
    const req = chat({ model: 'gpt-6.1-sol', image: IMAGE })
    const res = await p().stream(req)
    expect(res.text).toBe(EXPECTED)
    expect(res.finish).toBe('stop')
    expect(req.deltas.join('')).toBe(EXPECTED)
    expect(req.deltas.length).toBeGreaterThan(3)
    const body = mock.chatRequests()[0].body as Record<string, any>
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('SYSTEM PROMPT')
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.temperature).toBeUndefined()
    expect(body.input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'auto' })
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/)
    expect(mock.chatRequests()[0].headers.authorization).toBe('Bearer sk-test')
  })

  it('retries without `reasoning` for models that reject it', async () => {
    mock.options = { failNext: { status: 400, count: 1, body: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error' } } } }
    const provider = p()
    const res = await provider.stream(chat({ model: 'gpt-4o' }))
    expect(res.text).toBe(EXPECTED)
    const reqs = mock.chatRequests()
    expect(reqs).toHaveLength(2)
    expect((reqs[1].body as Record<string, unknown>).reasoning).toBeUndefined()
  })

  it('answers without reasoning at "minimal" effort, stepping down to the lowest value a model accepts', async () => {
    const provider = p()
    await provider.stream(chat({ model: 'gpt-6-luna', effort: 'minimal' }))
    expect((mock.chatRequests()[0].body as Record<string, any>).reasoning).toEqual({ effort: 'none' })
    // A model without `none` (e.g. GPT-5) gets `minimal`, and is not sent `none` again.
    mock.requests.length = 0
    mock.options = { failNext: { status: 400, count: 1, body: { error: { message: "Unsupported value: 'none' is not supported with the 'gpt-5' model for 'reasoning.effort'.", type: 'invalid_request_error', param: 'reasoning.effort' } } } }
    await provider.stream(chat({ model: 'gpt-5', effort: 'minimal' }))
    await provider.stream(chat({ model: 'gpt-5', effort: 'minimal' }))
    const efforts = mock.chatRequests().map((r) => (r.body as Record<string, any>).reasoning?.effort)
    expect(efforts).toEqual(['none', 'minimal', 'minimal'])
  })

  it('transcribes WAV audio with gpt-transcribe and diarization', async () => {
    mock.options = { transcripts: ['Can you explain the caching layer?', 'Diarized words'] }
    const wav = readFileSync(path.join(__dirname, '../fixtures/question.wav'))
    const r = await p().transcribe({ wav, durationMs: 3000, model: 'gpt-transcribe', language: 'en', signal: new AbortController().signal })
    expect(r.text).toBe('Can you explain the caching layer?')
    const raw = mock.requests.find((x) => x.path.endsWith('/audio/transcriptions'))!.raw.toString('latin1')
    expect(raw).toContain('name="model"')
    expect(raw).toContain('gpt-transcribe')
    expect(raw).toContain('filename="segment.wav"')
    expect(raw).toContain('languages')
    const d = await p().transcribe({ wav, durationMs: 3000, model: 'gpt-transcribe', diarize: true, signal: new AbortController().signal })
    expect(d.parts[0]).toMatchObject({ text: 'Diarized words', speaker: 'A', startMs: 0, endMs: 2500 })
  })

  it('maps authentication failures', async () => {
    mock.options = { failNext: { status: 401, count: 1, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } } }
    await expect(p().stream(chat({ model: 'gpt-6.1-sol' }))).rejects.toMatchObject({ kind: 'auth' })
  })

  it('can be cancelled mid-stream', async () => {
    mock.options = { chunkDelayMs: 50 }
    const ctrl = new AbortController()
    const req = chat({ model: 'gpt-6.1-sol', signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 120)
    await expect(p().stream(req)).rejects.toMatchObject({ kind: 'aborted' })
    expect(req.deltas.join('').length).toBeLessThan(EXPECTED.length)
  })
})

describe('Anthropic provider (Messages API)', () => {
  const p = (): AnthropicProvider => new AnthropicProvider({ apiKey: 'sk-ant-test', baseURL: `${mock.url}/anthropic` })

  it('lists models with capabilities from the Models API', async () => {
    const models = await p().listModels()
    expect(models[0]).toMatchObject({ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', contextWindow: 1_000_000, vision: true, visionSource: 'api' })
  })

  it('streams with effort, refusal fallback and an image block', async () => {
    const provider = p()
    await provider.listModels()
    const req = chat({ model: 'claude-opus-5-5', image: IMAGE, effort: 'medium' })
    const res = await provider.stream(req)
    expect(res.text).toBe(EXPECTED)
    expect(res.finish).toBe('stop')
    const r = mock.chatRequests()[0]
    const body = r.body as Record<string, any>
    expect(body.system).toBe('SYSTEM PROMPT')
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.fallbacks).toBe('default')
    expect(String(r.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(body.thinking).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } })
    expect(r.headers['x-api-key']).toBe('sk-ant-test')
  })

  it('uses Claude’s fastest effort level for "minimal"', async () => {
    const provider = p()
    await provider.listModels()
    await provider.stream(chat({ model: 'claude-opus-5-5', effort: 'minimal' }))
    expect((mock.chatRequests()[0].body as Record<string, any>).output_config).toEqual({ effort: 'low' })
  })

  it('does not send fallbacks to models that do not support it', async () => {
    const provider = p()
    await provider.listModels()
    await provider.stream(chat({ model: 'claude-haiku-5-5' }))
    const body = mock.chatRequests()[0].body as Record<string, unknown>
    expect(body.fallbacks).toBeUndefined()
  })
})

describe('Gemini provider (generateContent)', () => {
  const p = (): GeminiProvider => new GeminiProvider({ apiKey: 'AIza-test', baseURL: `${mock.url}/gemini` })

  it('lists generateContent models with token limits', async () => {
    const models = await p().listModels()
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
    expect(models[0]).toMatchObject({ contextWindow: 1_048_576, vision: true, audioInput: true })
  })

  it('streams with systemInstruction, thinkingLevel and inline image', async () => {
    const req = chat({ model: 'gemini-3.8-flash', image: IMAGE })
    const res = await p().stream(req)
    expect(res.text).toBe(EXPECTED)
    const body = mock.chatRequests()[0].body as Record<string, any>
    expect(JSON.stringify(body.systemInstruction)).toContain('SYSTEM PROMPT')
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW')
    expect(body.generationConfig.temperature).toBeUndefined()
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg')
    expect(mock.chatRequests()[0].headers['x-goog-api-key']).toBe('AIza-test')
  })

  it('asks for MINIMAL thinking at "minimal" effort, so the answer starts straight away', async () => {
    await p().stream(chat({ model: 'gemini-3.8-flash', effort: 'minimal' }))
    expect((mock.chatRequests()[0].body as Record<string, any>).generationConfig.thinkingConfig.thinkingLevel).toBe('MINIMAL')
  })

  it('steps down the thinking level when the model rejects it', async () => {
    mock.options = { failNext: { status: 400, count: 1, body: { error: { code: 400, message: 'thinking_level MINIMAL is not supported for this model', status: 'INVALID_ARGUMENT' } } } }
    const provider = p()
    const res = await provider.stream(chat({ model: 'gemini-3.8-flash' }))
    expect(res.text).toBe(EXPECTED)
    const reqs = mock.chatRequests()
    expect(reqs).toHaveLength(2)
    expect((reqs[1].body as Record<string, any>).generationConfig.thinkingConfig).toBeUndefined()
  })

  it('remembers rejected levels per model but keeps honouring the requested effort', async () => {
    const provider = p()
    mock.options = { failNext: { status: 400, count: 1, body: { error: { code: 400, message: 'thinking level MEDIUM is not supported', status: 'INVALID_ARGUMENT' } } } }
    await provider.stream(chat({ model: 'gemini-x', effort: 'medium' }))
    await provider.stream(chat({ model: 'gemini-x', effort: 'low' }))
    await provider.stream(chat({ model: 'gemini-x', effort: 'medium' }))
    const levels = mock.chatRequests().map((r) => (r.body as Record<string, any>).generationConfig.thinkingConfig?.thinkingLevel)
    // MEDIUM rejected → LOW; then LOW for the short answer; MEDIUM is not retried for this model.
    expect(levels).toEqual(['MEDIUM', 'LOW', 'LOW', 'LOW'])
  })

  it('transcribes inline WAV audio', async () => {
    mock.options = { transcripts: ['Gemini heard this.'] }
    const wav = readFileSync(path.join(__dirname, '../fixtures/question.wav'))
    const r = await p().transcribe({ wav, durationMs: 3000, model: 'gemini-3.5-flash-lite', signal: new AbortController().signal })
    expect(r.text).toBe('Gemini heard this.')
    const body = mock.requests.find((x) => x.path.endsWith(':generateContent'))!.body as Record<string, any>
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('audio/wav')
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('MINIMAL')
  })
})

describe('Moonshot provider (Kimi, OpenAI-compatible)', () => {
  const p = (): MoonshotProvider => new MoonshotProvider({ apiKey: 'sk-kimi', baseURL: `${mock.url}/moonshot/v1` })

  it('reads capability flags from the model list', async () => {
    const models = await p().listModels()
    expect(models[0]).toMatchObject({ id: 'kimi-k2.6', contextWindow: 262_144, vision: true, visionSource: 'api' })
  })

  it('streams chat completions without sampling params and with model-specific reasoning', async () => {
    const res = await p().stream(chat({ model: 'kimi-k2.6', image: IMAGE }))
    expect(res.text).toBe(EXPECTED)
    expect(res.finish).toBe('stop')
    const body = mock.chatRequests()[0].body as Record<string, any>
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' })
    expect(body.messages[1].content[0]).toMatchObject({ type: 'image_url' })
    mock.requests.length = 0
    await p().stream(chat({ model: 'kimi-k3', effort: 'medium' }))
    const k3 = mock.chatRequests()[0].body as Record<string, any>
    expect(k3.reasoning_effort).toBe('high')
    expect(k3.thinking).toBeUndefined()
  })
})

describe('DeepSeek provider (OpenAI-compatible chat completions)', () => {
  const p = (): DeepSeekProvider => new DeepSeekProvider({ apiKey: 'sk-ds-test', baseURL: `${mock.url}/deepseek` })

  it('reads context window and image support from the model list', async () => {
    const models = await p().listModels()
    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(models[0]).toMatchObject({ displayName: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxOutputTokens: 393216, vision: true, visionSource: 'api' })
    expect(models[1]).toMatchObject({ vision: false, visionSource: 'api' })
  })

  it('answers fast without thinking for short styles and hides reasoning text', async () => {
    const req = chat({ model: 'deepseek-flash', image: IMAGE })
    const res = await p().stream(req)
    expect(res.text).toBe(EXPECTED)
    expect(req.deltas.join('')).not.toContain('internal reasoning')
    const r = mock.chatRequests()[0]
    const body = r.body as Record<string, any>
    expect(r.headers.authorization).toBe('Bearer sk-ds-test')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' })
    expect(body.messages[1].content[0]).toMatchObject({ type: 'image_url' })
  })

  it('thinks with low effort for detailed answers', async () => {
    await p().stream(chat({ model: 'deepseek-flash', effort: 'medium' }))
    const body = mock.chatRequests()[0].body as Record<string, any>
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
  })

  it('falls back to screen text when a model rejects images', async () => {
    const res = await p().stream(chat({ model: 'deepseek-v4-pro', image: IMAGE }))
    expect(res.text).toBe(EXPECTED)
    expect(res.notes?.join(' ')).toMatch(/screen text/)
    const reqs = mock.chatRequests()
    expect(reqs).toHaveLength(2)
    expect(JSON.stringify(reqs[1].body)).not.toContain('image_url')
  })
})
