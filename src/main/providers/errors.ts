import type { ProviderId } from '@shared/types'
import { PROVIDER_LABELS } from '@shared/types'

export type ProviderErrorKind =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'bad_request'
  | 'context_length'
  | 'unsupported'
  | 'server'
  | 'refusal'
  | 'aborted'
  | 'not_configured'
  | 'unknown'

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly raw?: unknown,
    /** Provider-specific, user-facing explanation that replaces the generic message. */
    readonly hint?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server'
  }

  /** Message suitable for the UI. */
  get userMessage(): string {
    if (this.hint) return this.hint
    const p = PROVIDER_LABELS[this.provider]
    switch (this.kind) {
      case 'auth':
        return `${p}: the API key was rejected. Check it in Settings → Providers.`
      case 'permission':
        return `${p}: this key does not have access to the selected model or feature.`
      case 'rate_limit':
        return `${p}: rate limit reached${this.retryAfterMs ? ` — retrying in ${Math.ceil(this.retryAfterMs / 1000)}s` : ''}.`
      case 'quota':
        return `${p}: quota or billing limit reached. Check your plan/credits on the provider dashboard.`
      case 'network':
        return `${p}: cannot reach the API. Check your internet connection or proxy.`
      case 'timeout':
        return `${p}: the request timed out.`
      case 'not_found':
        return `${p}: model or endpoint not found — pick another model in Settings.`
      case 'context_length':
        return `${p}: the request was too long for this model. Lower "Max context" in Settings or use a larger model.`
      case 'unsupported':
        return `${p}: ${this.message}`
      case 'server':
        return `${p}: the service is temporarily unavailable (${this.status ?? 'error'}).`
      case 'refusal':
        return `${p}: the model declined this request.`
      case 'aborted':
        return 'Cancelled.'
      case 'not_configured':
        return `${p} is not configured. Add an API key in Settings → Providers.`
      default:
        return `${p}: ${this.message}`
    }
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const rec = headers as Record<string, string>
  return rec[name] ?? rec[name.toLowerCase()]
}

function parseRetryAfter(headers: unknown): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms')
  if (ms && !Number.isNaN(Number(ms))) return Number(ms)
  const s = headerValue(headers, 'retry-after')
  if (!s) return undefined
  if (!Number.isNaN(Number(s))) return Number(s) * 1000
  const date = Date.parse(s)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/**
 * Map SDK errors (OpenAI, Anthropic, Google GenAI, fetch) to a ProviderError. The SDKs expose a
 * numeric `status` on API errors and use distinct class names for connection/abort failures.
 */
export function normalizeError(provider: ProviderId, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  const e = err as {
    name?: string
    message?: string
    status?: number
    code?: string
    headers?: unknown
    error?: { type?: string; code?: string; message?: string }
    cause?: unknown
  }
  const name = e?.name ?? ''
  const message = String(e?.message ?? err ?? 'Unknown error')
  const lower = message.toLowerCase()

  if (name === 'AbortError' || name === 'APIUserAbortError' || lower.includes('request was aborted') || lower === 'aborted') {
    return new ProviderError(provider, 'aborted', 'Cancelled', undefined, undefined, err)
  }
  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    if (typeof e.status !== 'number') return new ProviderError(provider, 'timeout', message, undefined, undefined, err)
  }
  if (
    name === 'APIConnectionError' ||
    e?.code === 'ECONNREFUSED' ||
    e?.code === 'ENOTFOUND' ||
    e?.code === 'ECONNRESET' ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('connection error')
  ) {
    if (typeof e.status !== 'number') return new ProviderError(provider, 'network', message, undefined, undefined, err)
  }

  const status = typeof e?.status === 'number' ? e.status : undefined
  const retryAfter = parseRetryAfter(e?.headers)
  const code = `${e?.error?.type ?? ''} ${e?.error?.code ?? ''} ${e?.code ?? ''}`.toLowerCase()

  if (status === 401) return new ProviderError(provider, 'auth', message, status, undefined, err)
  if (status === 403) return new ProviderError(provider, 'permission', message, status, undefined, err)
  if (status === 404) return new ProviderError(provider, 'not_found', message, status, undefined, err)
  if (status === 402 || code.includes('insufficient_quota') || lower.includes('insufficient balance') || lower.includes('exceeded your current quota') || lower.includes('credit balance')) {
    return new ProviderError(provider, 'quota', message, status, undefined, err)
  }
  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('rate limit')) {
    return new ProviderError(provider, 'rate_limit', message, status, retryAfter ?? 5000, err)
  }
  if (status === 408) return new ProviderError(provider, 'timeout', message, status, undefined, err)
  if (status === 413 || code.includes('context_length') || lower.includes('context length') || lower.includes('too long') || lower.includes('maximum context') || lower.includes('prompt is too long') || lower.includes('exceeds the maximum')) {
    return new ProviderError(provider, 'context_length', message, status, undefined, err)
  }
  if (status !== undefined && status >= 500) return new ProviderError(provider, 'server', message, status, retryAfter, err)
  if (status === 400 || status === 422 || code.includes('invalid_request')) {
    return new ProviderError(provider, 'bad_request', message, status, undefined, err)
  }
  return new ProviderError(provider, 'unknown', message, status, undefined, err)
}

/** True for 400s that complain about a specific request parameter we can drop and retry without. */
export function isUnsupportedParamError(err: ProviderError, ...params: string[]): boolean {
  if (err.kind !== 'bad_request') return false
  const m = err.message.toLowerCase()
  return params.some((p) => m.includes(p.toLowerCase()))
}

/** Some SDK streams end quietly when aborted; make cancellation explicit. */
export function throwIfAborted(provider: ProviderId, signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError(provider, 'aborted', 'Cancelled')
}
