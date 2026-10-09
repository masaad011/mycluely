import { describe, expect, it } from 'vitest'
import { buildContext, planRollingSummary, type ContextInput } from '@shared/context'
import { parseSummary } from '@shared/summary'
import { assessScreenQuality, intersect, toFractions } from '@shared/screen'
import type { ScreenSnapshot, TranscriptSegment } from '@shared/types'
import { estimateTokens } from '@shared/util'

const START = 1_700_000_000_000

function segs(count: number, words = 12): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    source: i % 2 ? 'mic' : 'system',
    speaker: i % 2 ? 'You' : 'Remote',
    text: `Line ${i}: ` + Array.from({ length: words }, (_, w) => `word${w}`).join(' '),
    startMs: i * 5000,
    endMs: i * 5000 + 4000,
    at: START + i * 5000,
    status: 'ok' as const
  }))
}

const snap: ScreenSnapshot = {
  id: 'scr1',
  at: START + 60_000,
  trigger: 'manual',
  sourceId: 'screen:1:0',
  sourceName: 'Screen 1',
  sourceKind: 'screen',
  width: 1600,
  height: 900,
  ocrText: 'Quarterly Revenue Review\nQ3 revenue grew 18%',
  ocrConfidence: 62,
  quality: 'partial',
  imagePath: 'C:/tmp/x.jpg'
}

function input(over: Partial<ContextInput> = {}): ContextInput {
  return {
    action: 'answer',
    mode: 'technical',
    style: 'short',
    meetingTitle: 'Arch review',
    startedAt: START,
    now: START + 120_000,
    segments: segs(6),
    budgetTokens: 20_000,
    modelVision: true,
    imagePolicy: 'explain',
    ...over
  }
}

describe('context builder', () => {
  it('includes mode, style, transcript, screen and task', () => {
    const c = buildContext(input({ snapshot: snap, questionText: 'How does caching work?' }))
    expect(c.system).toContain('technical discussion')
    expect(c.system).toContain('Response length: short')
    expect(c.user).toContain('[00:00] Remote: Line 0')
    expect(c.user).toContain('Quarterly Revenue Review')
    expect(c.user).toContain('partially readable')
    expect(c.user).toContain('A participant asked: "How does caching work?"')
    // Screen-quality warnings are only shown on screen explanations, not on every answer.
    expect(c.notes.some((n) => n.includes('partially readable'))).toBe(false)
    // Image only attached for explain-screen with the explain-only policy.
    expect(c.attachImage).toBe(false)
  })

  it('warns about weak OCR only when explaining the screen without the image', () => {
    const textOnly = buildContext(input({ action: 'explain-screen', snapshot: snap, modelVision: false }))
    expect(textOnly.notes.join(' ')).toContain('partially readable')
    const withImage = buildContext(input({ action: 'explain-screen', snapshot: snap, modelVision: true }))
    expect(withImage.attachImage).toBe(true)
    expect(withImage.notes.join(' ')).not.toContain('partially readable')
  })

  it("'auto' policy sends the screenshot when OCR is weak and the capture is recent", () => {
    const weak = buildContext(input({ snapshot: snap, imagePolicy: 'auto' }))
    expect(weak.attachImage).toBe(true)
    const clear = buildContext(input({ snapshot: { ...snap, quality: 'clear', ocrConfidence: 92 }, imagePolicy: 'auto' }))
    expect(clear.attachImage).toBe(false)
    const old = buildContext(input({ snapshot: snap, imagePolicy: 'auto', now: snap.at + 10 * 60_000 }))
    expect(old.attachImage).toBe(false)
    expect(buildContext(input({ action: 'explain-screen', snapshot: { ...snap, quality: 'clear' }, imagePolicy: 'auto' })).attachImage).toBe(true)
  })

  it("at Fastest speed, 'auto' sends screenshots only for Explain screen", () => {
    expect(buildContext(input({ snapshot: snap, imagePolicy: 'auto', speed: 'fast' })).attachImage).toBe(false)
    expect(buildContext(input({ action: 'explain-screen', snapshot: snap, imagePolicy: 'auto', speed: 'fast' })).attachImage).toBe(true)
    expect(buildContext(input({ snapshot: snap, imagePolicy: 'auto', speed: 'balanced' })).attachImage).toBe(true)
    // An explicit "always" is still honoured.
    expect(buildContext(input({ snapshot: snap, imagePolicy: 'always', speed: 'fast' })).attachImage).toBe(true)
  })

  it('puts the stable transcript before per-request details so providers can cache the prefix', () => {
    const c = buildContext(input({ segments: segs(6), snapshot: snap }))
    const at = (s: string) => c.user.indexOf(s)
    expect(at('<transcript>')).toBe(0)
    expect(at('<transcript>')).toBeLessThan(at('<meeting>'))
    expect(at('<meeting>')).toBeLessThan(at('<screen'))
    expect(at('<screen')).toBeLessThan(at('<task>'))
    // The same transcript yields the same prefix even as time passes and the task changes.
    const later = buildContext(input({ action: 'suggest', segments: segs(6), snapshot: snap, now: START + 300_000 }))
    const prefix = c.user.slice(0, at('<meeting>'))
    expect(later.user.startsWith(prefix)).toBe(true)
  })

  it('attaches the screenshot for explain-screen on vision models and notes text-only models', () => {
    expect(buildContext(input({ action: 'explain-screen', snapshot: snap })).attachImage).toBe(true)
    const textOnly = buildContext(input({ action: 'explain-screen', snapshot: snap, modelVision: false }))
    expect(textOnly.attachImage).toBe(false)
    expect(textOnly.notes.join(' ')).toContain('no image input')
    expect(buildContext(input({ action: 'explain-screen' })).notes).toContain('No screen capture available.')
  })

  it('keeps the newest lines within the token budget and reports omissions', () => {
    const c = buildContext(input({ segments: segs(400, 30), budgetTokens: 4000 }))
    expect(c.estimatedTokens).toBeLessThan(4600)
    expect(c.omittedLines).toBeGreaterThan(300)
    expect(c.user).toContain('Line 399')
    expect(c.user).not.toContain('Line 0:')
    expect(c.user).toMatch(/earlier lines not shown/)
  })

  it('uses the rolling summary for long meetings', () => {
    const c = buildContext(input({ segments: segs(400, 30), budgetTokens: 4000, rollingSummary: '- Agreed on Postgres.', summarizedCount: 300 }))
    expect(c.user).toContain('<earlier_discussion_summary>')
    expect(c.notes).toContain('Earlier discussion included as a summary.')
  })

  it('lists questions already suggested this meeting so "Questions to ask" offers new ones', () => {
    const resp = (id: string, action: 'suggest' | 'answer', text: string) =>
      ({ id, action, text, status: 'done', provider: 'openai', model: 'm', style: 'short', at: START }) as const
    const previousResponses = [
      resp('r1', 'suggest', '- What is the cache TTL? (freshness)\n- Who owns the migration? (owner)'),
      resp('r2', 'answer', 'We roll back from the snapshot.'),
      resp('r3', 'answer', 'Latency is 120 ms.'),
      resp('r4', 'answer', 'Thursday.'),
      resp('r5', 'suggest', '- What is the cache TTL? (again)\n- Can we see p95 latency first? (evidence)')
    ]
    const c = buildContext(input({ action: 'suggest', segments: segs(4), previousResponses: [...previousResponses] }))
    const block = /<already_suggested_questions>\n([\s\S]*?)\n<\/already_suggested_questions>/.exec(c.user)?.[1]
    // Includes suggestions older than the last-3 response history, newest first, without duplicates.
    expect(block?.split('\n')).toEqual(['- What is the cache TTL?', '- Can we see p95 latency first?', '- Who owns the migration?'])
    expect(c.user).toMatch(/Suggest exactly 3 questions the user could ask the other participants/)
    expect(buildContext(input({ action: 'answer', segments: segs(4), previousResponses: [...previousResponses] })).user).not.toContain('already_suggested')
    expect(buildContext(input({ action: 'suggest', segments: [] })).notes).toContain('No transcript yet.')
  })

  it('flags an empty transcript', () => {
    const c = buildContext(input({ segments: [] }))
    expect(c.user).toContain('no speech has been transcribed yet')
    expect(c.notes).toContain('No transcript yet.')
  })

  it('plans rolling summaries only when the transcript outgrows the budget', () => {
    expect(planRollingSummary(segs(10), 0, 10_000)).toBeNull()
    const plan = planRollingSummary(segs(400, 30), 0, 10_000)
    expect(plan).not.toBeNull()
    expect(plan!.from).toBe(0)
    expect(plan!.to).toBeGreaterThan(100)
    expect(plan!.to).toBeLessThan(400)
  })

  it('estimates tokens roughly', () => {
    expect(estimateTokens('hello world, this is a test')).toBeGreaterThan(4)
    expect(estimateTokens('日本語のテキスト')).toBe(8)
  })
})

describe('summary parsing', () => {
  it('parses sectioned markdown', () => {
    const s = parseSummary(`## Overview
We reviewed Q3.

## Key points
- Revenue up 18%
- Churn down

## Decisions
- Adopt Postgres

## Action items
1. Sam — migrate billing — November

## Open questions
- None yet`)
    expect(s.overview).toBe('We reviewed Q3.')
    expect(s.keyPoints).toEqual(['Revenue up 18%', 'Churn down'])
    expect(s.decisions).toEqual(['Adopt Postgres'])
    expect(s.actionItems).toEqual(['Sam — migrate billing — November'])
    expect(s.openQuestions).toEqual([])
  })

  it('keeps unstructured output as the overview', () => {
    expect(parseSummary('Just a paragraph.').overview).toBe('Just a paragraph.')
  })
})

describe('screen helpers', () => {
  it('rates OCR quality', () => {
    expect(assessScreenQuality({ text: 'Quarterly Revenue Review grew 18 percent', confidence: 91 }).quality).toBe('clear')
    expect(assessScreenQuality({ text: 'Quarterly Revenue Review grew 18 percent', confidence: 60 }).quality).toBe('partial')
    expect(assessScreenQuality({ text: 'x', confidence: 90 }).quality).toBe('unreadable')
    const blank = assessScreenQuality({ text: '', confidence: 0, blankness: 0.999 })
    expect(blank.quality).toBe('unreadable')
    expect(blank.note).toMatch(/blank/)
  })

  it('converts rectangles to display fractions', () => {
    const f = toFractions({ x: 1920 + 480, y: 270, width: 960, height: 540 }, { x: 1920, y: 0, width: 1920, height: 1080 })
    expect(f).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBeNull()
  })
})
