import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { meetingToMarkdown } from '@shared/export'
import { promptText } from '../helpers/mock-providers'
import { createHarness, fixtureWav as wav, waitFor, type Harness } from '../helpers/session-harness'

describe('core meeting workflow (headless)', () => {
  let h: Harness
  let mock: Harness['mock']
  let session: Harness['session']
  let store: Harness['store']
  let settingsStore: Harness['settings']
  let capture: Harness['capture']
  let events: Harness['events']
  let dir: string

  beforeAll(async () => {
    h = await createHarness({
      settings: { assistant: { autoSuggest: 'questions' } },
      mock: {
        transcripts: [
          'Can you explain how the caching layer handles invalidation when the database changes?',
          'Thank you.' // hallucination on a short segment → dropped
        ]
      },
      env: { OPENAI_API_KEY: 'sk-integration-test', ANTHROPIC_API_KEY: 'sk-ant-integration' }
    })
    ;({ mock, session, store, capture, events, dir } = h)
    settingsStore = h.settings
  })

  afterAll(async () => {
    await h.close()
  })

  it('starts capture and reports provider status', async () => {
    await session.start({ title: 'Architecture sync', mode: 'technical' })
    expect(capture.commands[0]).toMatchObject({ type: 'start', audio: { micEnabled: true, systemEnabled: true } })
    const status = session.getStatus()
    expect(status.session).toBe('running')
    expect(status.ai).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', configured: true, vision: true })
    expect(status.transcription.engine).toBe('openai') // auto → OpenAI because a key exists
  })

  it('transcribes remote audio, labels the speaker and detects the question', async () => {
    const t0 = session.meeting.record.startedAt
    session.onAudioSegment({ source: 'system', startedAt: t0 + 2000, durationMs: 5200, peakDb: -12, wav: wav('question.wav') })
    session.onAudioSegment({ source: 'mic', startedAt: t0 + 9000, durationMs: 900, peakDb: -30, wav: wav('answer.wav') })
    const seg = await waitFor(() => session.meeting.record.segments.find((s) => s.source === 'system'))
    expect(seg).toMatchObject({ speaker: 'Remote', status: 'ok', startMs: 2000 })
    expect(seg.text).toContain('caching layer')
    const q = await waitFor(() => session.meeting.questions[0])
    expect(q.text).toContain('caching layer handles invalidation')
    expect(events.of('questions').length).toBeGreaterThan(0)
    // The "Thank you." hallucination from the short mic segment is filtered out.
    await waitFor(() => session.transcription.pending === 0 && session.meeting.record.segments.length >= 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(session.meeting.record.segments.filter((s) => s.source === 'mic')).toHaveLength(0)
    const upload = mock.requests.find((r) => r.path.endsWith('/audio/transcriptions'))!
    expect(upload.raw.toString('latin1')).toContain('gpt-transcribe')
  })

  it('captures the screen, masks the overlay and reads the slide with OCR', async () => {
    const snap = await session.captureScreen('manual')
    expect(snap).not.toBeNull()
    expect(capture.grabs[0].masks).toHaveLength(1)
    expect(capture.grabs[0].masks[0].x).toBeCloseTo(1500 / 1920)
    expect(snap!.quality).toBe('clear')
    expect(snap!.ocrConfidence).toBeGreaterThan(75)
    expect(snap!.ocrText).toContain('Quarterly Revenue Review')
    expect(snap!.ocrText).toMatch(/Postgres/)
    expect(snap!.imagePath).toBeTruthy()
  }, 60_000)

  it('answers the latest question using transcript and screen context', async () => {
    const id = await session.runAction({ action: 'answer' })
    await session.assistant.wait(id)
    const r = session.meeting.findResponse(id)!
    expect(r.status).toBe('done')
    expect(r.text).toContain('change events')
    expect(r.questionId).toBe(session.meeting.questions[0].id)
    expect(session.meeting.questions[0].status).toBe('answered')
    const req = mock.chatRequests().at(-1)!
    const prompt = promptText(req.body)
    expect(prompt).toContain('A participant asked: "Can you explain how the caching layer handles invalidation')
    expect(prompt).toContain('[00:02] Remote:')
    expect(prompt).toContain('Quarterly Revenue Review')
    expect(prompt).toContain('technical discussion')
    expect((req.body as Record<string, unknown>).store).toBe(false)
    // Default image policy: no screenshot for a plain answer.
    expect(JSON.stringify(req.body)).not.toContain('input_image')
    // Streaming deltas were broadcast.
    expect(events.of('response-delta').filter((d) => d.id === id).length).toBeGreaterThan(0)
  })

  it('explains the screen with the screenshot attached for a vision model', async () => {
    const id = await session.runAction({ action: 'explain-screen' })
    await session.assistant.wait(id)
    const r = session.meeting.findResponse(id)!
    expect(r.status).toBe('done')
    expect(r.usedImage).toBe(true)
    const body = mock.chatRequests().at(-1)!.body as { input: { content: { type: string }[] }[] }
    expect(body.input[0].content.some((c) => c.type === 'input_image')).toBe(true)
  })

  it('switches provider mid-meeting and keeps the context', async () => {
    // Switch to Anthropic (mock) mid-meeting: the next request goes there with the same context.
    await settingsStore.update({ ai: { provider: 'anthropic', baseUrls: { openai: `${mock.url}/openai/v1`, anthropic: `${mock.url}/anthropic` } } })
    const switched = await session.runAction({ action: 'ask', prompt: 'What was asked about caching?' })
    await session.assistant.wait(switched)
    const sr = session.meeting.findResponse(switched)!
    expect(sr).toMatchObject({ status: 'done', provider: 'anthropic', model: 'claude-opus-5-5' })
    const anthropicReq = mock.chatRequests().at(-1)!
    expect(anthropicReq.path).toBe('/anthropic/v1/messages')
    expect(promptText(anthropicReq.body)).toContain('caching layer handles invalidation')
    expect(promptText(anthropicReq.body)).toContain('Quarterly Revenue Review')
    await settingsStore.update({ ai: { provider: 'openai' } })
    // Ask with a custom question; then regenerate and refine.
    const id = await session.runAction({ action: 'ask', prompt: 'What did they ask about caching?' })
    await session.assistant.wait(id)
    const refined = session.assistant.refine(id, 'Make it shorter.')
    await session.assistant.wait(refined)
    const rr = session.meeting.findResponse(refined)!
    expect(rr.status).toBe('done')
    expect(promptText(mock.chatRequests().at(-1)!.body)).toContain('<previous_response>')
  })

  it('reports errors without breaking the session', async () => {
    mock.options = { ...mock.options, failNext: { status: 401, count: 1, body: { error: { message: 'Incorrect API key', type: 'invalid_request_error' } } } }
    const id = await session.runAction({ action: 'suggest' })
    await session.assistant.wait(id)
    const r = session.meeting.findResponse(id)!
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/API key was rejected/)
    expect(events.of('toast').some((t) => /API key/.test(t.message))).toBe(true)
    expect(session.getStatus().session).toBe('running')
  })

  it('pauses, resumes and stops with an automatic summary saved to history', async () => {
    session.pause()
    expect(session.getStatus().session).toBe('paused')
    session.resume()
    expect(session.getStatus().session).toBe('running')
    // Add one more line so the summary has at least two lines to work with.
    mock.options = { ...mock.options, transcripts: ['Sure, we publish change events and evict keys within a second.'] }
    const t0 = session.meeting.record.startedAt
    session.onAudioSegment({ source: 'mic', startedAt: t0 + 20_000, durationMs: 5000, peakDb: -15, wav: wav('answer.wav') })
    await waitFor(() => session.meeting.record.segments.some((s) => s.source === 'mic'))
    await session.stop()
    expect(capture.commands.map((c) => c.type)).toEqual(['start', 'pause', 'resume', 'stop'])
    const id = session.meeting.id
    const summary = session.meeting.record.summary
    expect(summary?.decisions).toContain('Use change events for cache invalidation')
    expect(summary?.actionItems[0]).toContain('Postgres')

    const saved = await store.get(id)
    expect(saved?.title).toBe('Architecture sync')
    expect(saved?.segments.map((s) => s.speaker)).toEqual(['Remote', 'You'])
    expect(saved?.summary?.keyPoints.length).toBeGreaterThan(0)
    expect(saved?.snapshots[0].ocrText).toContain('Quarterly Revenue Review')
    // Screenshots are not retained by default.
    expect(saved?.snapshots[0].imagePath).toBeUndefined()
    await expect(readdir(path.join(dir, 'session-cache', id))).rejects.toThrow()
    const md = meetingToMarkdown(saved!, { includeScreens: true })
    expect(md).toContain('## Summary')
    expect(md).toContain('Quarterly Revenue Review')
    expect((await store.list())[0].id).toBe(id)
  })
})
