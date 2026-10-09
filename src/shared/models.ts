import type { ResponseSpeed } from './settings'
import type { ModelInfo, ProviderId } from './types'

/**
 * Capability knowledge used only when a provider's model list does not say.
 * Anthropic (`capabilities.image_input`, `max_input_tokens`), Moonshot (`supports_image_in`,
 * `context_length`), DeepSeek (`input_modalities`, `context_window`) and Gemini (`inputTokenLimit`)
 * publish metadata, so these heuristics mostly
 * matter for OpenAI, whose /v1/models returns ids only. Users can override vision per model.
 *
 * Recommended ids were checked against the official model pages on 2026-10-08; they only order
 * the list — whatever the provider returns live is what the user can pick.
 */
export const RECOMMENDED_MODELS: Record<ProviderId, string[]> = {
  chatgpt: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
  openai: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
  moonshot: ['kimi-k2.6', 'kimi-k3'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro']
}

export const RECOMMENDED_TRANSCRIPTION_MODELS = {
  openai: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
  local: [
    'onnx-community/whisper-base.en',
    'onnx-community/whisper-tiny.en',
    'onnx-community/whisper-small.en',
    'onnx-community/whisper-base'
  ]
}

const OPENAI_NON_CHAT =
  /(embedding|tts|whisper|transcribe|realtime|audio|image|dall-e|moderation|search|computer-use|codex|live|instruct|babbage|davinci|sora|omni-moderation)/i

export function isChatModel(provider: ProviderId, id: string): boolean {
  const m = id.toLowerCase()
  switch (provider) {
    case 'chatgpt':
      return true // the plan's model list is already limited to models offered to the account
    case 'openai':
      return /^(gpt-|o\d|chatgpt-)/.test(m) && !OPENAI_NON_CHAT.test(m)
    case 'anthropic':
      return m.startsWith('claude')
    case 'gemini':
      return m.startsWith('gemini') && !/(embedding|tts|image-generation|-image|live|transcribe|native-audio|robotics|computer-use|aqa)/.test(m)
    case 'moonshot':
      return /^(kimi|moonshot)/.test(m)
    case 'deepseek':
      return m.startsWith('deepseek')
  }
}

export function heuristicVision(provider: ProviderId, id: string): boolean {
  const m = id.toLowerCase()
  switch (provider) {
    case 'chatgpt':
    case 'openai': {
      if (/^(o1-mini|o3-mini|gpt-3\.5|gpt-4-0|gpt-4$|gpt-4-32k)/.test(m)) return false
      const major = /^gpt-(\d+)/.exec(m)
      if (major && Number(major[1]) >= 5) return true
      return /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|chatgpt-4o|o1|o3|o4)/.test(m)
    }
    case 'anthropic':
      return !/claude-(instant|2)/.test(m)
    case 'gemini':
      return true
    case 'moonshot':
      // Current Kimi models (k2.6+, k3) accept images; legacy moonshot-v1 text models do not.
      return /vision|vl|kimi-k(2\.[5-9]|3|[4-9])/.test(m)
    case 'deepseek':
      // DeepSeek-V4.1-Flash (`deepseek-flash`) accepts images; V4-Pro is text-only.
      return /flash|vision/.test(m)
  }
}

export function heuristicContextWindow(provider: ProviderId, id: string): number | undefined {
  const m = id.toLowerCase()
  if (provider === 'openai' || provider === 'chatgpt') {
    const major = /^gpt-(\d+)/.exec(m)
    if (major && Number(major[1]) >= 6) return 1_050_000
    if (/^gpt-5/.test(m)) return 400_000
    if (/^gpt-4\.1/.test(m)) return 1_047_576
    if (/^(gpt-4o|gpt-4-turbo|chatgpt-4o|o1)/.test(m)) return 128_000
    if (/^(o3|o4)/.test(m)) return 200_000
  }
  if (provider === 'moonshot') {
    if (/kimi-k3/.test(m)) return 1_048_576
    if (/kimi-k2/.test(m)) return 262_144
  }
  if (provider === 'deepseek' && /deepseek-(flash|v4)/.test(m)) return 1_048_576
  return undefined
}

export function visionOverrideKey(provider: ProviderId, model: string): string {
  return `${provider}:${model}`
}

export function resolveVision(
  info: Pick<ModelInfo, 'vision' | 'visionSource'> | undefined,
  provider: ProviderId,
  model: string,
  overrides: Record<string, boolean>
): { vision: boolean; source: ModelInfo['visionSource'] } {
  const key = visionOverrideKey(provider, model)
  if (key in overrides) return { vision: overrides[key], source: 'override' }
  if (info) return { vision: info.vision, source: info.visionSource }
  return { vision: heuristicVision(provider, model), source: 'heuristic' }
}

/** Recommended models first (in recommendation order), then newest first. */
export function sortModels(provider: ProviderId, models: ModelInfo[]): ModelInfo[] {
  const rec = RECOMMENDED_MODELS[provider]
  return models.slice().sort((a, b) => {
    const ra = rec.indexOf(a.id)
    const rb = rec.indexOf(b.id)
    if (ra !== -1 || rb !== -1) return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb)
    return (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id)
  })
}

/**
 * How much the model may think before answering. `minimal` answers straight away (each provider's
 * fastest setting); `medium` thinks first, which adds seconds before the first word.
 */
export type Effort = 'minimal' | 'low' | 'medium'

/** Reasoning/latency preference for a response style: quick styles ask for little thinking. */
export function effortForStyle(style: string): 'low' | 'medium' {
  return style === 'detailed' || style === 'technical' ? 'medium' : 'low'
}

/**
 * Effort for an assistant action. "Fastest" (the default) skips extended thinking for everything
 * used live — the style still sets length and tone — and gives summaries a little. "Balanced"
 * thinks longer for Detailed and Technical answers.
 */
export function effortFor(action: string, style: string, speed: ResponseSpeed): Effort {
  if (speed === 'fast') return action === 'summarize' ? 'low' : 'minimal'
  return effortForStyle(style)
}
