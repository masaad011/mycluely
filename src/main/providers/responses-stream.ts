import type OpenAI from 'openai'
import type { ProviderId } from '@shared/types'
import { throwIfAborted } from './errors'
import type { ChatRequest, ChatResult } from './types'

/** Values for the Responses API `reasoning.effort` field. */
export type Effort = 'none' | 'minimal' | 'low' | 'medium'

/**
 * Responses API reasoning values to try for an effort level, fastest first. Models differ in the
 * lowest value they accept (GPT-5.1 and later `none`, GPT-5 `minimal`, older models no reasoning
 * at all), so providers step down this list when a value is rejected — ending with no `reasoning`
 * field — and remember the step per model.
 */
export function effortLadder(effort: ChatRequest['effort']): (Effort | undefined)[] {
  switch (effort) {
    case 'minimal':
      return ['none', 'minimal', 'low', undefined]
    case 'low':
      return ['low', undefined]
    case 'medium':
      return ['medium', undefined]
  }
}

export interface ResponsesOptions {
  provider: ProviderId
  effort?: Effort
  /** Attach `req.image` as an input_image (dropped when a backend rejects images). */
  sendImage: boolean
  /** Send the system prompt as a developer message instead of `instructions`. */
  instructionsInInput?: boolean
}

/** HTTP status that matches a structured Responses error code (used for error mapping). */
const STATUS_FOR_CODE: Record<string, number> = {
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_user_unavailable: 503
}

/**
 * Stream one Responses API request (`POST /v1/responses`, `store: false`) and forward text
 * deltas. Shared by the OpenAI API-key provider and the ChatGPT-plan provider.
 */
export async function streamResponses(client: OpenAI, req: ChatRequest, o: ResponsesOptions): Promise<ChatResult> {
  const content: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: req.user }]
  if (req.image && o.sendImage) {
    content.push({
      type: 'input_image',
      image_url: `data:${req.image.mimeType};base64,${req.image.base64}`,
      detail: 'auto'
    })
  }
  const input: OpenAI.Responses.ResponseInputItem[] = []
  if (o.instructionsInInput) input.push({ role: 'developer', content: req.system })
  input.push({ role: 'user', content })
  // Reasoning tokens count against max_output_tokens, so leave headroom for them.
  const reserve = o.effort === 'medium' ? 12_000 : o.effort === 'low' ? 4_000 : o.effort ? 1_000 : 0
  const stream = await client.responses.create(
    {
      model: req.model,
      ...(o.instructionsInInput ? {} : { instructions: req.system }),
      input,
      max_output_tokens: req.maxOutputTokens + reserve,
      store: false,
      stream: true,
      ...(o.effort ? { reasoning: { effort: o.effort } } : {})
    },
    { signal: req.signal, timeout: req.timeoutMs }
  )
  let text = ''
  let finish: ChatResult['finish'] = 'other'
  let refusal = ''
  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta
        req.onDelta(event.delta)
        break
      case 'response.refusal.delta':
        refusal += event.delta
        break
      case 'response.completed':
        finish = 'stop'
        break
      case 'response.incomplete':
        finish = event.response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'other'
        break
      case 'response.failed': {
        const err = event.response.error as { code?: string; message?: string; param?: string } | null | undefined
        const code = err?.code
        throw Object.assign(new Error(err?.message ?? 'Response failed'), {
          status: (code && STATUS_FOR_CODE[code]) ?? 500,
          code,
          param: err?.param,
          error: err ?? undefined
        })
      }
      case 'error':
        throw Object.assign(new Error(event.message ?? 'Stream error'), { code: event.code, param: event.param })
    }
  }
  throwIfAborted(o.provider, req.signal)
  if (!text && refusal) {
    req.onDelta(refusal)
    return { text: refusal, finish: 'refusal' }
  }
  return { text, finish }
}
