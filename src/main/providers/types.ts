import type { Effort } from '@shared/models'
import type { ModelInfo, ProviderId } from '@shared/types'

export interface ChatImage {
  mimeType: 'image/jpeg' | 'image/png'
  base64: string
}

export interface ChatRequest {
  model: string
  system: string
  user: string
  image?: ChatImage
  maxOutputTokens: number
  /** Latency/quality trade-off mapped onto each provider's reasoning controls. */
  effort: Effort
  signal: AbortSignal
  timeoutMs: number
  onDelta: (text: string) => void
}

export interface ChatResult {
  text: string
  finish: 'stop' | 'length' | 'refusal' | 'other'
  /** Model that actually produced the answer (differs when a server-side fallback ran). */
  servedBy?: string
  notes?: string[]
}

export interface TranscribeRequest {
  wav: Uint8Array
  durationMs: number
  model: string
  language?: string
  /** Recent transcript text to help with names/jargon continuity. */
  prompt?: string
  diarize?: boolean
  signal: AbortSignal
}

export interface TranscribedPart {
  text: string
  /** Provider speaker label (diarization), e.g. "A", "spk_1". */
  speaker?: string
  startMs?: number
  endMs?: number
}

export interface TranscribeResult {
  text: string
  parts: TranscribedPart[]
}

export interface LlmProvider {
  readonly id: ProviderId
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  stream(req: ChatRequest): Promise<ChatResult>
}

export interface SpeechToText {
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>
}

export interface ProviderConfig {
  apiKey: string
  baseURL?: string
  timeoutMs?: number
}
