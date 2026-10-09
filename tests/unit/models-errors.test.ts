import { describe, expect, it } from 'vitest'
import { effortFor, heuristicVision, isChatModel, resolveVision, sortModels } from '@shared/models'
import type { ModelInfo } from '@shared/types'
import { ProviderError, isUnsupportedParamError, normalizeError } from '../../src/main/providers/errors'

describe('response speed', () => {
  it('skips extended thinking at Fastest whatever the style, and thinks for Detailed/Technical at Balanced', () => {
    expect(effortFor('answer', 'technical', 'fast')).toBe('minimal')
    expect(effortFor('suggest', 'detailed', 'fast')).toBe('minimal')
    expect(effortFor('summarize', 'short', 'fast')).toBe('low')
    expect(effortFor('answer', 'technical', 'balanced')).toBe('medium')
    expect(effortFor('answer', 'short', 'balanced')).toBe('low')
  })
})

describe('model capability heuristics', () => {
  it('filters chat models from provider listings', () => {
    expect(isChatModel('openai', 'gpt-6.1-sol')).toBe(true)
    expect(isChatModel('openai', 'text-embedding-3-small')).toBe(false)
    expect(isChatModel('openai', 'gpt-transcribe')).toBe(false)
    expect(isChatModel('openai', 'gpt-realtime')).toBe(false)
    expect(isChatModel('gemini', 'gemini-3.8-flash')).toBe(true)
    expect(isChatModel('gemini', 'gemini-3.5-transcribe')).toBe(false)
    expect(isChatModel('gemini', 'gemini-embedding-001')).toBe(false)
    expect(isChatModel('moonshot', 'kimi-k2.6')).toBe(true)
    expect(isChatModel('deepseek', 'deepseek-flash')).toBe(true)
  })

  it('guesses vision support and honours overrides', () => {
    expect(heuristicVision('openai', 'gpt-6-luna')).toBe(true)
    expect(heuristicVision('openai', 'gpt-7-something')).toBe(true)
    expect(heuristicVision('openai', 'gpt-3.5-turbo')).toBe(false)
    expect(heuristicVision('moonshot', 'kimi-k3')).toBe(true)
    expect(heuristicVision('moonshot', 'moonshot-v1-8k')).toBe(false)
    expect(heuristicVision('deepseek', 'deepseek-flash')).toBe(true)
    expect(heuristicVision('deepseek', 'deepseek-v4-pro')).toBe(false)
    expect(resolveVision(undefined, 'openai', 'gpt-6-luna', { 'openai:gpt-6-luna': false })).toEqual({ vision: false, source: 'override' })
    const info = { vision: true, visionSource: 'api' } as ModelInfo
    expect(resolveVision(info, 'anthropic', 'claude-x', {})).toEqual({ vision: true, source: 'api' })
  })

  it('orders recommended models first, then newest', () => {
    const mk = (id: string, createdAt: number): ModelInfo => ({ id, provider: 'openai', displayName: id, vision: true, visionSource: 'heuristic', audioInput: false, createdAt })
    const sorted = sortModels('openai', [mk('gpt-4o', 1), mk('gpt-6-luna', 2), mk('gpt-9-future', 9), mk('gpt-6.1-sol', 3)])
    expect(sorted.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-9-future', 'gpt-4o'])
  })
})

describe('provider error normalisation', () => {
  it('maps HTTP status codes and SDK error names', () => {
    expect(normalizeError('openai', { status: 401, message: 'bad key' }).kind).toBe('auth')
    const rl = normalizeError('anthropic', { status: 429, message: 'slow down', headers: new Headers({ 'retry-after': '7' }) })
    expect(rl.kind).toBe('rate_limit')
    expect(rl.retryAfterMs).toBe(7000)
    expect(rl.retryable).toBe(true)
    expect(normalizeError('openai', { status: 429, message: 'You exceeded your current quota', error: { code: 'insufficient_quota' } }).kind).toBe('quota')
    expect(normalizeError('gemini', { status: 503, message: 'overloaded' }).kind).toBe('server')
    expect(normalizeError('openai', { status: 400, message: "This model's maximum context length is 128000 tokens" }).kind).toBe('context_length')
    expect(normalizeError('openai', { name: 'APIConnectionError', message: 'Connection error.' }).kind).toBe('network')
    expect(normalizeError('openai', { name: 'APIUserAbortError', message: 'Request was aborted.' }).kind).toBe('aborted')
    expect(normalizeError('moonshot', { status: 404, message: 'model not found' }).kind).toBe('not_found')
  })

  it('produces actionable user messages', () => {
    expect(new ProviderError('anthropic', 'not_configured', 'x').userMessage).toMatch(/Settings/)
    expect(new ProviderError('openai', 'auth', 'x').userMessage).toMatch(/API key was rejected/)
    const e = normalizeError('openai', { status: 400, message: "Unsupported parameter: 'reasoning.effort'" })
    expect(isUnsupportedParamError(e, 'reasoning')).toBe(true)
    expect(isUnsupportedParamError(e, 'thinking')).toBe(false)
  })
})
