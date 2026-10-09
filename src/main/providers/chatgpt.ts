import OpenAI from 'openai'
import type { ModelInfo } from '@shared/types'
import { heuristicContextWindow, heuristicVision, sortModels } from '@shared/models'
import { CHATGPT_RESOURCE, CHATGPT_USAGE_URL, ChatGPTAuthError, type ChatGPTAuth } from '../services/chatgpt-auth'
import { ProviderError, normalizeError } from './errors'
import { effortLadder, streamResponses } from './responses-stream'
import type { ChatRequest, ChatResult, LlmProvider } from './types'

interface PlanModel {
  slug: string
  display_name?: string
  visibility?: string
}

type Dropped = 'image' | 'instructions'

function errorCode(err: unknown): { code?: string; param?: string } {
  const e = err as { code?: string; param?: string; error?: { code?: string; param?: string } }
  return { code: e?.code ?? e?.error?.code, param: e?.param ?? e?.error?.param }
}

/** Map "Sign in with ChatGPT" error codes to actionable messages (OpenAI errors-and-recovery guide). */
export function normalizeChatGPTError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof ChatGPTAuthError) {
    const signedOut = err.code === 'sign_in_required' || err.code === 'not_signed_in'
    return new ProviderError(
      'chatgpt',
      signedOut ? 'auth' : 'unknown',
      err.message,
      undefined,
      undefined,
      err,
      signedOut
        ? 'ChatGPT plan: you are signed out. Use “Continue with ChatGPT” in Settings → API keys & providers.'
        : `ChatGPT plan: ${err.message}`
    )
  }
  const { code, param } = errorCode(err)
  const base = normalizeError('chatgpt', err)
  const make = (kind: ProviderError['kind'], hint: string): ProviderError =>
    new ProviderError('chatgpt', kind, base.message, base.status, base.retryAfterMs, err, hint)
  switch (code) {
    case 'subscription_sharing_user_not_eligible':
      return make('permission', 'ChatGPT plan: this account or workspace can’t use its plan in apps (Plus or Pro is required). Use an API-key provider instead.')
    case 'subscription_sharing_usage_limit_exceeded':
      return make('quota', `ChatGPT plan: you’ve reached the usage limit available to MyCluely. Check ${CHATGPT_USAGE_URL}, wait for it to reset, or switch provider.`)
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ProviderError('chatgpt', 'server', base.message, 503, 5000, err, 'ChatGPT plan usage is temporarily unavailable — try again shortly.')
    case 'subscription_sharing_unsupported_capability':
      return make('unsupported', `ChatGPT plan: this request uses a feature plan usage doesn’t support${param ? ` (${param})` : ''}.`)
    case 'subscription_sharing_route_not_supported':
      return make('unsupported', 'ChatGPT plan: this kind of request isn’t available with plan usage.')
    case 'subscription_sharing_invalid_user':
      return make('auth', 'ChatGPT plan: your sign-in is no longer valid. Sign in again in Settings → API keys & providers.')
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return make('permission', 'ChatGPT plan: MyCluely wasn’t granted plan usage. Sign in again and approve “Use your ChatGPT plan”.')
  }
  if (base.kind === 'auth') return make('auth', 'ChatGPT plan: your sign-in was rejected. Sign in again in Settings → API keys & providers.')
  if (base.kind === 'permission') {
    return make('permission', 'ChatGPT plan: access was refused (for example, not available in your region or blocked by workspace policy).')
  }
  return base
}

/**
 * OpenAI models paid from the user's ChatGPT plan ("Sign in with ChatGPT"). Uses the public
 * Responses API with the OAuth access token, with `store: false` and streaming on every request
 * as the plan-usage flow requires. Speech-to-text isn't available this way.
 */
export class ChatGPTPlanProvider implements LlmProvider {
  readonly id = 'chatgpt' as const
  private readonly client: OpenAI
  /** Request features a model rejected under plan usage; dropped on later calls. */
  private readonly unsupported = new Map<string, Set<Dropped>>()
  /** Per model and effort: the first `effortLadder` step plan usage accepts. */
  private readonly effortStep = new Map<string, number>()

  constructor(
    private readonly auth: ChatGPTAuth,
    private readonly opts: { baseURL?: string; timeoutMs?: number } = {}
  ) {
    this.client = new OpenAI({
      apiKey: () => this.auth.accessToken(),
      baseURL: opts.baseURL ?? CHATGPT_RESOURCE,
      timeout: opts.timeoutMs ?? 90_000,
      maxRetries: 0
    })
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const token = await this.auth.accessToken()
      const res = await fetch(`${this.opts.baseURL ?? CHATGPT_RESOURCE}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ?? AbortSignal.timeout(20_000)
      })
      const body = (await res.json().catch(() => ({}))) as {
        models?: PlanModel[]
        data?: { id: string }[]
        error?: { code?: string; message?: string }
        detail?: string
      }
      if (!res.ok) {
        throw Object.assign(new Error(body.error?.message ?? body.detail ?? `HTTP ${res.status}`), {
          status: res.status,
          code: body.error?.code,
          error: body.error
        })
      }
      // Plan accounts list models as { slug, display_name, visibility }; keep the listed ones.
      const list: PlanModel[] = body.models ?? (body.data ?? []).map((m) => ({ slug: m.id, visibility: 'list' }))
      const out: ModelInfo[] = list
        .filter((m) => m.slug && (m.visibility ?? 'list') === 'list')
        .map((m) => ({
          id: m.slug,
          provider: 'chatgpt',
          displayName: m.display_name || m.slug,
          contextWindow: heuristicContextWindow('chatgpt', m.slug),
          vision: heuristicVision('chatgpt', m.slug),
          visionSource: 'heuristic',
          audioInput: false
        }))
      return sortModels('chatgpt', out)
    } catch (err) {
      throw normalizeChatGPTError(err)
    }
  }

  async stream(req: ChatRequest): Promise<ChatResult> {
    let dropped = this.unsupported.get(req.model)
    if (!dropped) {
      dropped = new Set()
      this.unsupported.set(req.model, dropped)
    }
    const ladder = effortLadder(req.effort)
    const effortKey = `${req.model}|${req.effort}`
    let step = this.effortStep.get(effortKey) ?? 0
    let refreshedOnce = false
    for (let attempt = 0; attempt < 8; attempt++) {
      let emitted = false
      try {
        const result = await streamResponses(
          this.client,
          {
            ...req,
            onDelta: (d) => {
              emitted = true
              req.onDelta(d)
            }
          },
          {
            provider: 'chatgpt',
            effort: ladder[step],
            sendImage: !dropped.has('image'),
            instructionsInInput: dropped.has('instructions')
          }
        )
        const notes = req.image && dropped.has('image') ? ['ChatGPT plan usage didn’t accept the screenshot for this model — used screen text only.'] : []
        return { ...result, notes: [...(result.notes ?? []), ...notes] }
      } catch (err) {
        const e = normalizeChatGPTError(err)
        if (emitted || req.signal.aborted) throw e
        const { code, param } = errorCode(err)
        // Remove the unsupported part and retry — never resend an identical body.
        if (code === 'subscription_sharing_unsupported_capability' || e.kind === 'bad_request') {
          const what = `${param ?? ''} ${e.message}`.toLowerCase()
          if (/image/.test(what) && req.image && !dropped.has('image')) {
            dropped.add('image')
            continue
          }
          if (/reasoning|effort/.test(what) && step < ladder.length - 1) {
            this.effortStep.set(effortKey, ++step)
            continue
          }
          if (/instructions/.test(what) && !dropped.has('instructions')) {
            dropped.add('instructions')
            continue
          }
          throw e
        }
        // One refresh-and-retry when the grant looks invalid; otherwise ask to sign in again.
        if (e.kind === 'auth' && !refreshedOnce) {
          refreshedOnce = true
          if (await this.auth.handleInvalidUser()) continue
        }
        throw e
      }
    }
    throw new ProviderError('chatgpt', 'unsupported', 'The request could not be adapted to ChatGPT plan usage.')
  }
}
