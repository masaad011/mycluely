import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for the OpenAI, Anthropic, Gemini and Moonshot HTTP APIs. It speaks each
 * provider's wire format (SSE streams, JSON shapes) so the official SDKs run unmodified against
 * it. Base URLs:
 *   OpenAI    `${url}/openai/v1`      Anthropic `${url}/anthropic`
 *   Gemini    `${url}/gemini`         Moonshot  `${url}/moonshot/v1`
 *   DeepSeek  `${url}/deepseek`
 */
export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: unknown
  raw: Buffer
}

export interface MockOptions {
  /** Text the chat endpoints stream back. Defaults to a reply chosen from the prompt. */
  reply?: (prompt: string, req: RecordedRequest) => string
  /** Queue of texts returned by transcription endpoints (falls back to `defaultTranscript`). */
  transcripts?: string[]
  defaultTranscript?: string
  /** Respond with this HTTP status for the next N chat requests (error-path tests). */
  failNext?: { status: number; count: number; body?: unknown; headers?: Record<string, string> }
  /** Delay between streamed chunks (ms). */
  chunkDelayMs?: number
}

export interface MockServer {
  url: string
  requests: RecordedRequest[]
  options: MockOptions
  close(): Promise<void>
  chatRequests(): RecordedRequest[]
  /** TCP connections opened so far (to check that clients reuse connections). */
  connections(): number
}

export const SUMMARY_MARKDOWN = `## Overview
The team reviewed Q3 results and the caching layer.

## Key points
- Q3 revenue grew 18% to $4.2M
- Cache hit rate improved to 93%

## Decisions
- Use change events for cache invalidation

## Action items
- Sam — migrate billing service to Postgres — November

## Open questions
- None yet`

export function defaultReply(prompt: string): string {
  if (/Summarize the meeting so far/.test(prompt)) return SUMMARY_MARKDOWN
  if (/running summary|Update the summary/i.test(prompt)) return '- Discussed caching and Q3 results.'
  if (/Explain what is on the user's screen/.test(prompt)) {
    return 'This slide is a **Quarterly Revenue Review**: revenue grew 18% to $4.2M and churn fell to 2.1%.'
  }
  // Screen answers: the quiz fixture has a question; anything else (in Auto mode) has nothing to answer.
  const quiz = /Which data structure gives/.test(prompt)
  if (/Answer what needs answering on the user's screen/.test(prompt)) {
    if (quiz) return '**B) Hash table** — hashing gives O(1) average lookup by key.'
    if (/reply with exactly NOTHING_TO_ANSWER/.test(prompt)) return 'NOTHING_TO_ANSWER'
    return 'Mock answer from the test server.'
  }
  if (/shown on the screen/.test(prompt) && quiz) return '**B) Hash table** — hashing gives O(1) average lookup by key.'
  if (/Suggest exactly 3 questions/.test(prompt)) {
    return '- What is the cache TTL? (clarifies freshness)\n- Who owns the Postgres migration? (ownership)\n- What is the rollback plan? (risk)'
  }
  if (/Draft the answer|draft the answer/.test(prompt)) {
    return 'We publish change events from the database and the cache evicts affected keys within about a second.'
  }
  return 'Mock answer from the test server.'
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function chunksOf(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 12) out.push(text.slice(i, i + 12))
  return out.length ? out : ['']
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Extract all prompt text from any provider's request body. */
export function promptText(body: unknown): string {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'data' || k === 'image_url' || k === 'url') continue // skip base64 payloads
        walk(x)
      }
    }
  }
  walk(body)
  return parts.join('\n')
}

export async function startMockProviders(options: MockOptions = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = []
  const state = { options }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const raw = await readBody(req)
    let body: unknown = undefined
    const ct = String(req.headers['content-type'] ?? '')
    if (ct.includes('application/json') && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        body = raw.toString('utf8')
      }
    } else if (raw.length) {
      body = raw.toString('latin1')
    }
    const rec: RecordedRequest = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body, raw }
    requests.push(rec)
    const o = state.options
    const delay = o.chunkDelayMs ?? 5
    const isChat =
      /\/(responses|chat\/completions|messages)$/.test(u.pathname) || /:streamGenerateContent$/.test(u.pathname)
    if (isChat && o.failNext && o.failNext.count > 0) {
      o.failNext.count--
      return json(res, o.failNext.status, o.failNext.body ?? { error: { message: `mock ${o.failNext.status}`, type: 'mock_error' } }, o.failNext.headers)
    }
    const reply = (): string => (o.reply ?? defaultReply)(promptText(body), rec)
    const nextTranscript = (): string => o.transcripts?.shift() ?? o.defaultTranscript ?? 'Hello from the mock transcription.'

    try {
      // ---------------- OpenAI
      if (u.pathname === '/openai/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: [
            { id: 'gpt-6.1-sol', object: 'model', created: 1790000000, owned_by: 'openai' },
            { id: 'gpt-6-luna', object: 'model', created: 1790000001, owned_by: 'openai' },
            { id: 'gpt-4o', object: 'model', created: 1715000000, owned_by: 'openai' },
            { id: 'text-embedding-3-small', object: 'model', created: 1700000000, owned_by: 'openai' },
            { id: 'gpt-transcribe', object: 'model', created: 1790000002, owned_by: 'openai' }
          ]
        })
      }
      if (u.pathname === '/openai/v1/audio/transcriptions') {
        const text = nextTranscript()
        if (rec.raw.toString('latin1').includes('diarized_json')) {
          return json(res, 200, {
            task: 'transcribe',
            duration: 3,
            text,
            segments: [{ type: 'transcript.text.segment', id: 'seg_0', start: 0, end: 2.5, text, speaker: 'A' }]
          })
        }
        return json(res, 200, { text })
      }
      if (u.pathname === '/openai/v1/responses') {
        const text = reply()
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let seq = 0
        const send = (type: string, data: Record<string, unknown>): void => {
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
        }
        const response = { id: 'resp_mock', object: 'response', status: 'in_progress', model: (body as { model?: string })?.model, output: [] }
        send('response.created', { response })
        for (const c of chunksOf(text)) {
          send('response.output_text.delta', { item_id: 'msg_mock', output_index: 0, content_index: 0, delta: c, logprobs: [] })
          await sleep(delay)
        }
        send('response.output_text.done', { item_id: 'msg_mock', output_index: 0, content_index: 0, text, logprobs: [] })
        send('response.completed', {
          response: {
            ...response,
            status: 'completed',
            output: [{ id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]
          }
        })
        return res.end()
      }

      // ---------------- Moonshot (OpenAI-compatible chat completions)
      if (u.pathname === '/moonshot/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: [
            { id: 'kimi-k2.6', object: 'model', created: 1780000000, owned_by: 'moonshot', context_length: 262144, supports_image_in: true, supports_video_in: true, supports_reasoning: true },
            { id: 'kimi-k3', object: 'model', created: 1790000000, owned_by: 'moonshot', context_length: 1048576, supports_image_in: true, supports_video_in: true, supports_reasoning: true }
          ]
        })
      }
      if (u.pathname === '/moonshot/v1/chat/completions') {
        const text = reply()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const model = (body as { model?: string })?.model
        for (const [i, c] of chunksOf(text).entries()) {
          const delta = i === 0 ? { role: 'assistant', content: c } : { content: c }
          res.write(`data: ${JSON.stringify({ id: 'cmpl_mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
          await sleep(delay)
        }
        res.write(`data: ${JSON.stringify({ id: 'cmpl_mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }

      // ---------------- DeepSeek (OpenAI-compatible chat completions, base URL without /v1)
      if (u.pathname === '/deepseek/models') {
        return json(res, 200, {
          object: 'list',
          data: [
            {
              id: 'deepseek-flash',
              object: 'model',
              owned_by: 'deepseek',
              name: 'DeepSeek-V4.1-Flash',
              context_window: 1048576,
              max_output_tokens: 393216,
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
              effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
            },
            {
              id: 'deepseek-v4-pro',
              object: 'model',
              owned_by: 'deepseek',
              name: 'DeepSeek-V4-Pro',
              context_window: 1048576,
              max_output_tokens: 393216,
              input_modalities: ['text'],
              output_modalities: ['text'],
              effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
            }
          ]
        })
      }
      if (u.pathname === '/deepseek/chat/completions') {
        const b = body as { model?: string; messages?: unknown[] }
        if (b.model === 'deepseek-v4-pro' && JSON.stringify(b.messages).includes('image_url')) {
          return json(res, 400, { error: { message: 'This model does not support image', type: 'invalid_request_error' } })
        }
        const text = reply()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        // Thinking mode streams reasoning_content before the answer; it must not be shown.
        const sse = (delta: Record<string, unknown>, finish: string | null = null): void => {
          res.write('data: ' + JSON.stringify({ id: 'ds', object: 'chat.completion.chunk', created: 1, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n')
        }
        sse({ role: 'assistant', reasoning_content: 'internal reasoning' })
        for (const c of chunksOf(text)) {
          sse({ content: c })
          await sleep(delay)
        }
        sse({}, 'stop')
        res.write('data: [DONE]\n\n')
        return res.end()
      }

      // ---------------- Anthropic
      if (u.pathname === '/anthropic/v1/models') {
        const caps = (vision: boolean, effort: boolean) => ({
          image_input: { supported: vision },
          effort: { supported: effort, low: { supported: effort }, medium: { supported: effort }, high: { supported: effort } },
          thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
        })
        return json(res, 200, {
          data: [
            { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: caps(true, true) },
            { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-02T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: caps(true, true) }
          ],
          has_more: false,
          first_id: 'claude-opus-5-5',
          last_id: 'claude-haiku-5-5'
        })
      }
      if (u.pathname.startsWith('/anthropic/v1/models/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop() ?? '')
        return json(res, 200, { type: 'model', id, display_name: id, created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, effort: { supported: true } } })
      }
      if (u.pathname === '/anthropic/v1/messages') {
        const text = reply()
        const model = (body as { model?: string })?.model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: Record<string, unknown>): void => {
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        }
        send('message_start', {
          message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } }
        })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        for (const c of chunksOf(text)) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })
          await sleep(delay)
        }
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
        send('message_stop', {})
        return res.end()
      }

      // ---------------- Gemini
      if (u.pathname === '/gemini/v1beta/models') {
        return json(res, 200, {
          models: [
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-005', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }
          ]
        })
      }
      if (/^\/gemini\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(u.pathname)) {
        const text = reply()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const cs = chunksOf(text)
        for (const [i, c] of cs.entries()) {
          const last = i === cs.length - 1
          res.write(
            `data: ${JSON.stringify({
              candidates: [{ content: { role: 'model', parts: [{ text: c }] }, index: 0, ...(last ? { finishReason: 'STOP' } : {}) }],
              ...(last ? { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 } } : {})
            })}\r\n\r\n`
          )
          await sleep(delay)
        }
        return res.end()
      }
      if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname)) {
        const text = nextTranscript()
        return json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }] })
      }

      json(res, 404, { error: { message: `mock: no route for ${req.method} ${u.pathname}` } })
    } catch (err) {
      json(res, 500, { error: { message: String(err) } })
    }
  })

  // Like the real API servers: keep idle connections open, and send no `Keep-Alive: timeout`
  // hint (so a client falls back to its own idle timeout, as it does against the real APIs).
  server.keepAliveTimeout = 0
  let connections = 0
  server.on('connection', () => connections++)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get options() {
      return state.options
    },
    set options(v: MockOptions) {
      state.options = v
    },
    chatRequests: () => requests.filter((r) => /\/(responses|chat\/completions|messages)$|:streamGenerateContent$/.test(r.path)),
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  } as MockServer
}
