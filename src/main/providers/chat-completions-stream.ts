import type OpenAI from 'openai'
import type { ProviderId } from '@shared/types'
import { throwIfAborted } from './errors'
import type { ChatRequest, ChatResult } from './types'

export interface ChatCompletionsOptions {
  provider: ProviderId
  /** Attach `req.image` as an image_url part (only for models that accept images). */
  sendImage: boolean
  /** Output-token field and value (providers differ: max_tokens vs max_completion_tokens). */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  maxTokens: number
  /** Provider-specific body fields (reasoning controls etc.), not part of the OpenAI types. */
  extras?: Record<string, unknown>
}

/**
 * Stream one OpenAI-compatible Chat Completions request and forward text deltas. Reasoning text
 * (`reasoning_content`) is not shown. Used by providers whose official API is Chat Completions
 * compatible (Moonshot/Kimi, DeepSeek).
 */
export async function streamChatCompletions(client: OpenAI, req: ChatRequest, o: ChatCompletionsOptions): Promise<ChatResult> {
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = []
  if (req.image && o.sendImage) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${req.image.mimeType};base64,${req.image.base64}` } })
  }
  userContent.push({ type: 'text', text: req.user })
  const body = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: userContent }
    ],
    [o.maxTokensField]: o.maxTokens,
    stream: true,
    ...(o.extras ?? {})
  } as OpenAI.Chat.ChatCompletionCreateParamsStreaming
  const stream = await client.chat.completions.create(body, { signal: req.signal, timeout: req.timeoutMs })
  let text = ''
  let finish: ChatResult['finish'] = 'other'
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
      req.onDelta(delta)
    }
    if (choice?.finish_reason === 'stop') finish = 'stop'
    else if (choice?.finish_reason === 'length') finish = 'length'
    else if (choice?.finish_reason === 'content_filter') finish = 'refusal'
  }
  throwIfAborted(o.provider, req.signal)
  return { text, finish }
}
