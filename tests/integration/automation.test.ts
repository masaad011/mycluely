import { afterEach, describe, expect, it } from 'vitest'
import { promptText } from '../helpers/mock-providers'
import { createHarness, fixtureWav, waitFor, type Harness } from '../helpers/session-harness'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('automatic behaviour during a meeting', () => {
  it('captures the screen periodically and skips unchanged frames', async () => {
    h = await createHarness({ settings: { screen: { autoCapture: true, intervalSec: 3, skipUnchanged: true } } })
    await h.session.listSources()
    await h.session.start({ title: 'Auto capture' })
    // Immediate capture on start, then one every 3 s.
    await waitFor(() => h!.session.meeting.record.snapshots.length === 1 && h!.session.meeting.record.snapshots[0].quality !== 'pending', 30_000)
    const first = h.session.meeting.record.snapshots[0]
    await waitFor(() => h!.capture.grabs.length >= 2, 10_000)
    await new Promise((r) => setTimeout(r, 300))
    // Same hash → no new snapshot, but the existing one is marked as current.
    expect(h.session.meeting.record.snapshots).toHaveLength(1)
    expect(h.session.meeting.record.snapshots[0].at).toBeGreaterThan(first.at - 1)
    // A changed frame is processed again.
    h.capture.shade = 90
    await waitFor(() => h!.session.meeting.record.snapshots.length === 2, 10_000)
    h.session.pause()
    const grabs = h.capture.grabs.length
    await new Promise((r) => setTimeout(r, 3500))
    expect(h.capture.grabs.length).toBe(grabs) // no captures while paused
  }, 60_000)

  it('auto-answers each remote question, deferring one asked during the cooldown instead of dropping it', async () => {
    h = await createHarness({
      settings: { assistant: { autoSuggest: 'answers', suggestionCooldownSec: 5 } },
      mock: { transcripts: ['What is the rollback plan for the Postgres migration?', 'And who owns the cache invalidation work?'] }
    })
    await h.session.start({ title: 'Auto answers' })
    const t0 = h.session.meeting.record.startedAt
    const autoAnswers = () => h!.session.meeting.record.responses.filter((r) => r.auto && r.action === 'answer')
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 1000, durationMs: 4000, peakDb: -10, wav: fixtureWav('question.wav') })
    const first = await waitFor(() => autoAnswers()[0], 15_000)
    const firstAt = first.at
    await h.session.assistant.wait(first.id)
    const done = h.session.meeting.findResponse(first.id)!
    expect(done.status).toBe('done')
    // Each answer records how long it took to start and to finish (shown on the card).
    expect(done.firstTokenMs).toBeGreaterThanOrEqual(0)
    expect(done.totalMs).toBeGreaterThanOrEqual(done.firstTokenMs!)
    expect(promptText(h.mock.chatRequests().at(-1)!.body)).toContain('What is the rollback plan for the Postgres migration?')
    // A second question inside the 5 s cooldown is answered once the cooldown has passed.
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 9000, durationMs: 4000, peakDb: -10, wav: fixtureWav('question.wav') })
    await waitFor(() => h!.session.meeting.questions.length === 2, 15_000)
    const second = await waitFor(() => autoAnswers()[1], 15_000)
    expect(second.at - firstAt).toBeGreaterThanOrEqual(5000)
    expect(second.questionId).toBe(h.session.meeting.questions[1].id)
    await h.session.assistant.wait(second.id)
    expect(promptText(h.mock.chatRequests().at(-1)!.body)).toContain('And who owns the cache invalidation work?')
    expect(h.session.meeting.questions.every((q) => q.status === 'answered')).toBe(true)
  }, 60_000)

  it('waits for a click in manual mode, and answers the question just asked when auto-answer is switched on', async () => {
    h = await createHarness({
      settings: { assistant: { autoSuggest: 'questions' } },
      mock: { transcripts: ['What is the rollback plan for the Postgres migration?'] }
    })
    await h.session.start({ title: 'Manual answers' })
    const t0 = h.session.meeting.record.startedAt
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 1000, durationMs: 4000, peakDb: -10, wav: fixtureWav('question.wav') })
    await waitFor(() => h!.session.meeting.questions.length === 1, 15_000)
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.session.meeting.record.responses).toHaveLength(0)
    expect(h.session.meeting.questions[0].status).toBe('open')
    // Flipping the switch (Settings change → controller hook, as in the app) answers it right away.
    await h.settings.update({ assistant: { autoSuggest: 'answers' } })
    h.session.autoAnswerChanged()
    const auto = await waitFor(() => h!.session.meeting.record.responses.find((r) => r.auto), 15_000)
    expect(auto.questionId).toBe(h.session.meeting.questions[0].id)
  }, 60_000)

  it('drops a pending automatic answer when auto-answer is switched off', async () => {
    h = await createHarness({
      settings: { assistant: { autoSuggest: 'answers', suggestionCooldownSec: 5 } },
      mock: { transcripts: ['What is the rollback plan for the Postgres migration?'] }
    })
    await h.session.start({ title: 'Cancelled auto answer' })
    const t0 = h.session.meeting.record.startedAt
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 1000, durationMs: 4000, peakDb: -10, wav: fixtureWav('question.wav') })
    await waitFor(() => h!.session.meeting.questions.length === 1, 15_000)
    // Switched off within the short settle delay: nothing is sent.
    await h.settings.update({ assistant: { autoSuggest: 'questions' } })
    h.session.autoAnswerChanged()
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.session.meeting.record.responses).toHaveLength(0)
  }, 60_000)

  it('folds old discussion into a rolling summary to stay within the context budget', async () => {
    h = await createHarness({
      settings: { ai: { maxContextTokens: 2000 } },
      mock: { defaultTranscript: 'We discussed the deployment pipeline, rollout percentages, alerting thresholds and the on-call rotation for the new billing service in some detail.' }
    })
    await h.session.start({ title: 'Long meeting' })
    const t0 = h.session.meeting.record.startedAt
    // Feed segments one by one like a real meeting (a burst would be merged by the backlog logic).
    for (let i = 0; i < 40; i++) {
      h.session.onAudioSegment({ source: 'system', startedAt: t0 + i * 6000, durationMs: 5000, peakDb: -10, wav: fixtureWav('question.wav') })
      await waitFor(() => h!.session.meeting.record.segments.length === i + 1)
    }
    await waitFor(() => h!.session.meeting.record.rollingSummary, 30_000)
    expect(h.session.meeting.summarizedCount).toBeGreaterThan(0)
    const compaction = h.mock.chatRequests().find((r) => /Update the summary/.test(promptText(r.body)))
    expect(compaction).toBeDefined()
    // Later prompts include the summary and stay within budget.
    const id = await h.session.runAction({ action: 'ask', prompt: 'What did we decide?' })
    await h.session.assistant.wait(id)
    const prompt = promptText(h.mock.chatRequests().at(-1)!.body)
    expect(prompt).toContain('<earlier_discussion_summary>')
    // The assistant never budgets below 3K tokens (~4 chars each), whatever the setting.
    expect(prompt.length).toBeLessThan(3000 * 4.5)
  }, 60_000)

  it('retracts a microphone echo that was transcribed before the remote original', async () => {
    const line = 'Can we move the release to Thursday so QA has two more days?'
    h = await createHarness({ mock: { transcripts: [line, line] } })
    await h.session.start({ title: 'Echo' })
    const t0 = h.session.meeting.record.startedAt
    // The speaker echo reaches the microphone and is transcribed first…
    h.session.onAudioSegment({ source: 'mic', startedAt: t0 + 1200, durationMs: 3000, peakDb: -30, wav: fixtureWav('question.wav') })
    await waitFor(() => h!.session.meeting.record.segments.some((s) => s.source === 'mic'))
    // …then the original remote speech arrives and the echo is withdrawn.
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 1000, durationMs: 3500, peakDb: -10, wav: fixtureWav('question.wav') })
    await waitFor(() => h!.session.meeting.record.segments.some((s) => s.source === 'system'))
    expect(h.session.meeting.record.segments.map((s) => s.speaker)).toEqual(['Remote'])
    expect(h.events.of('segment').some((s) => s.status === 'removed' && s.source === 'mic')).toBe(true)
    await h.session.saveNow()
    const saved = await h.store.get(h.session.meeting.id)
    expect(saved?.segments.map((s) => s.source)).toEqual(['system'])
  })

  it('refuses to start a new meeting while the previous one is still stopping', async () => {
    h = await createHarness({ mock: { transcripts: ['First line about the budget.', 'Second line about hiring.'] } })
    await h.session.start({ title: 'First' })
    const first = h.session.meeting
    const t0 = first.record.startedAt
    h.session.onAudioSegment({ source: 'system', startedAt: t0 + 1000, durationMs: 3000, peakDb: -10, wav: fixtureWav('question.wav') })
    h.session.onAudioSegment({ source: 'mic', startedAt: t0 + 6000, durationMs: 3000, peakDb: -10, wav: fixtureWav('answer.wav') })
    await waitFor(() => first.record.segments.length === 2)
    const stopping = h.session.stop() // writes the final summary
    await waitFor(() => h!.session.getStatus().session === 'stopping')
    await h.session.start({ title: 'Second' })
    expect(h.session.meeting).toBe(first)
    expect(h.events.of('toast').some((t) => /finishing the previous meeting/i.test(t.message))).toBe(true)
    await stopping
    expect(h.session.getStatus().session).toBe('idle')
    const saved = await h.store.get(first.id)
    expect(saved?.endedAt).toBeDefined()
    expect(saved?.summary).toBeDefined()
    expect(h.capture.commands.map((c) => c.type)).toEqual(['start', 'stop'])
  })
})
