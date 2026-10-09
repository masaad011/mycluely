import { describe, expect, it } from 'vitest'
import { parseSuggestedQuestions } from '../../src/shared/suggestions'

describe('parseSuggestedQuestions', () => {
  it('splits the requested format into questions and reasons', () => {
    const text = '- What is the cache TTL? (clarifies freshness)\n- Who owns the Postgres migration? (ownership)\n- What is the rollback plan? (risk)'
    expect(parseSuggestedQuestions(text)).toEqual([
      { question: 'What is the cache TTL?', reason: 'clarifies freshness' },
      { question: 'Who owns the Postgres migration?', reason: 'ownership' },
      { question: 'What is the rollback plan?', reason: 'risk' }
    ])
  })

  it('handles numbered lists, bold, quotes and a reason on its own line', () => {
    const text = 'Here are some questions:\n1. **“Can we see p95 latency before Thursday?”**\n   (moves the decision forward)\n2) Is the migration reversible?'
    expect(parseSuggestedQuestions(text)).toEqual([
      { question: 'Can we see p95 latency before Thursday?', reason: 'moves the decision forward' },
      { question: 'Is the migration reversible?' }
    ])
  })

  it('keeps parentheses that belong to the question', () => {
    expect(parseSuggestedQuestions('- Does the SLA (99.9%) cover the EU region? (scope)')).toEqual([
      { question: 'Does the SLA (99.9%) cover the EU region?', reason: 'scope' }
    ])
    expect(parseSuggestedQuestions('- Should we use the v2 API (GraphQL) here')).toEqual([{ question: 'Should we use the v2 API (GraphQL) here' }])
  })

  it('falls back to lines ending in a question mark when there are no bullets, and returns partial results while streaming', () => {
    expect(parseSuggestedQuestions('What changed since last week?\nThat is all.')).toEqual([{ question: 'What changed since last week?' }])
    expect(parseSuggestedQuestions('- Who signs off on the rel')).toEqual([{ question: 'Who signs off on the rel' }])
    expect(parseSuggestedQuestions('')).toEqual([])
  })
})
