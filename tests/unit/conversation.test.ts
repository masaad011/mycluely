import { describe, expect, it } from 'vitest'
import { QuestionTracker, findQuestion, scoreSentence } from '@shared/questions'
import { cleanTranscriptText, isEchoOfRemote, isLikelyHallucination } from '@shared/transcript'
import type { TranscriptSegment } from '@shared/types'

let n = 0
function seg(source: 'mic' | 'system', text: string, startMs: number, durationMs = 3000): TranscriptSegment {
  return {
    id: `s${n++}`,
    source,
    speaker: source === 'mic' ? 'You' : 'Remote',
    text,
    startMs,
    endMs: startMs + durationMs,
    at: 1_700_000_000_000 + startMs,
    status: 'ok'
  }
}

describe('question scoring', () => {
  it.each([
    'Can you explain how the caching layer handles invalidation?',
    'What is the timeline for the migration?',
    'How would you design the retry logic',
    'Walk me through the deployment process.',
    'Do you have any concerns about the budget?'
  ])('detects "%s"', (q) => {
    expect(scoreSentence(q)).toBeGreaterThanOrEqual(0.5)
  })

  it.each(['That is the plan, right?', 'We shipped the release yesterday.', 'Okay?', 'Thanks everyone.'])(
    'does not flag "%s"',
    (s) => {
      expect(scoreSentence(s)).toBeLessThan(0.5)
    }
  )

  it('picks the question sentence out of a longer turn', () => {
    const r = findQuestion('We moved the API to Postgres last week. Performance is fine. What would you change in the schema?')
    expect(r?.text).toBe('What would you change in the schema?')
  })
})

describe('question tracker', () => {
  it('tracks remote questions and marks them answered when the user speaks enough', () => {
    const t = new QuestionTracker()
    const u1 = t.onSegment(seg('system', 'Can you explain how the caching layer handles invalidation?', 1000))
    expect(u1.added?.text).toContain('caching layer')
    expect(t.latestOpen(1_700_000_000_000 + 2000)?.id).toBe(u1.added?.id)
    // User's own questions are not tracked.
    expect(t.onSegment(seg('mic', 'Should I share my screen?', 5000)).added).toBeUndefined()
    const u2 = t.onSegment(seg('mic', 'Sure, we publish change events and the cache evicts the affected keys right away.', 6000))
    expect(u2.answeredIds).toEqual([u1.added!.id])
    expect(t.latestOpen(1_700_000_000_000 + 7000)).toBeUndefined()
  })

  it('joins a short trailing fragment to the previous remote segment', () => {
    const t = new QuestionTracker()
    t.onSegment(seg('system', 'So regarding the database migration', 0, 2000))
    const u = t.onSegment(seg('system', "what's the timeline?", 2300, 1200))
    expect(u.added?.text.toLowerCase()).toContain("what's the timeline")
  })

  it('does not duplicate the same question and supports dismiss', () => {
    const t = new QuestionTracker()
    const a = t.onSegment(seg('system', 'What is the budget for Q4?', 0))
    expect(t.onSegment(seg('system', 'What is the budget for Q4?', 9000)).added).toBeUndefined()
    t.dismiss(a.added!.id)
    expect(t.latestOpen(1_700_000_000_000 + 9500)).toBeUndefined()
  })
})

describe('transcript filters', () => {
  it('drops typical speech-to-text hallucinations on short segments', () => {
    expect(isLikelyHallucination('Thank you.', 1200)).toBe(true)
    expect(isLikelyHallucination(' [BLANK_AUDIO] ', 2000)).toBe(true)
    expect(isLikelyHallucination('you you you you', 3000)).toBe(true)
    expect(isLikelyHallucination('Thanks for watching!', 1500)).toBe(true)
    expect(isLikelyHallucination('Thank you, that answers my question about the cache.', 3000)).toBe(false)
    expect(cleanTranscriptText('Hello (music) there')).toBe('Hello there')
  })

  it('detects the microphone picking up remote speech (speaker echo)', () => {
    const remote = seg('system', 'Can you explain how the caching layer handles invalidation?', 1000)
    const echo = { text: 'can you explain how the caching layer handles invalidation', startMs: 1200, endMs: 4000 }
    expect(isEchoOfRemote(echo, [remote])).toBe(true)
    const fragment = { text: 'the caching layer handles', startMs: 1500, endMs: 2500 }
    expect(isEchoOfRemote(fragment, [remote])).toBe(true)
    const own = { text: 'We publish change events from the database.', startMs: 5000, endMs: 8000 }
    expect(isEchoOfRemote(own, [remote])).toBe(false)
    const late = { ...echo, startMs: 60_000, endMs: 63_000 }
    expect(isEchoOfRemote(late, [remote])).toBe(false)
  })
})
