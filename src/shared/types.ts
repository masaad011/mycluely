// Domain types shared by the main process, preload bridge and renderers.
// Everything here must stay serialisable (structured-clone safe) because it crosses IPC.

/**
 * `chatgpt` is OpenAI through "Sign in with ChatGPT": requests are paid from the user's ChatGPT
 * Plus/Pro plan allowance instead of an API key. `openai` is the regular pay-as-you-go API.
 */
export type ProviderId = 'chatgpt' | 'openai' | 'anthropic' | 'gemini' | 'moonshot' | 'deepseek'
export const PROVIDER_IDS: ProviderId[] = ['chatgpt', 'openai', 'anthropic', 'gemini', 'moonshot', 'deepseek']

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT plan',
  openai: 'OpenAI API',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  moonshot: 'Moonshot AI (Kimi)',
  deepseek: 'DeepSeek'
}

/** Engines that turn captured audio into text. `local` runs Whisper on-device (no credentials); `auto` picks OpenAI, then Gemini, then local, based on which keys are configured. */
export type TranscriptionEngineId = 'auto' | 'local' | 'openai' | 'gemini' | 'none'

export type MeetingMode = 'general' | 'technical' | 'standup' | 'client'
export const MEETING_MODES: { id: MeetingMode; label: string; description: string }[] = [
  { id: 'general', label: 'General meeting', description: 'Balanced help for any discussion.' },
  { id: 'technical', label: 'Technical discussion', description: 'Precise engineering answers, trade-offs and code.' },
  { id: 'standup', label: 'Standup', description: 'Brief status, blockers and follow-ups.' },
  { id: 'client', label: 'Client meeting', description: 'Professional, client-friendly wording; tracks commitments.' }
]

export type ResponseStyle = 'short' | 'detailed' | 'technical' | 'conversational'
export const RESPONSE_STYLES: { id: ResponseStyle; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'technical', label: 'Technical' },
  { id: 'conversational', label: 'Conversational' }
]

export type AssistantAction = 'answer' | 'screen-answer' | 'suggest' | 'explain-screen' | 'summarize' | 'ask' | 'refine'
export const ACTION_LABELS: Record<AssistantAction, string> = {
  answer: 'Answer latest question',
  'screen-answer': 'Answer from screen',
  suggest: 'Questions to ask',
  'explain-screen': 'Explain this screen',
  summarize: 'Summarize discussion',
  ask: 'Ask anything',
  refine: 'Refine'
}

export type AudioSourceKind = 'mic' | 'system'

export interface ModelInfo {
  id: string
  provider: ProviderId
  displayName: string
  /** Maximum input tokens, when the provider publishes it. */
  contextWindow?: number
  maxOutputTokens?: number
  /** Resolved image-input support. */
  vision: boolean
  /** Where the vision flag came from: provider metadata, a name heuristic, or a user override. */
  visionSource: 'api' | 'heuristic' | 'override'
  /** Whether the model can take audio input directly (used for Gemini transcription). */
  audioInput: boolean
  createdAt?: number
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  modelCount?: number
  message: string
}

export interface CredentialStatus {
  configured: boolean
  source: 'stored' | 'env' | 'none'
  /** Last 4 characters only; the key itself never leaves the main process. */
  hint?: string
  /** Set when a saved key exists but cannot be used (e.g. it can no longer be decrypted). */
  problem?: string
  /** Signed-in account (ChatGPT plan), shown instead of a key hint. */
  account?: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TranscriptSegment {
  id: string
  source: AudioSourceKind
  /** Display label: "You", "Remote", "Remote A", ... */
  speaker: string
  text: string
  /** Milliseconds since meeting start. */
  startMs: number
  endMs: number
  /** Wall clock (epoch ms) at segment start. */
  at: number
  /** `removed`: retracted after the fact (e.g. a microphone echo of remote speech). */
  status: 'ok' | 'failed' | 'removed'
  error?: string
  /** Set when the question detector flagged this segment. */
  questionId?: string
}

export type ScreenQuality = 'clear' | 'partial' | 'unreadable' | 'pending'

export interface ScreenSnapshot {
  id: string
  at: number
  trigger: 'manual' | 'auto'
  sourceId: string
  sourceName: string
  sourceKind: 'screen' | 'window'
  region?: Rect
  width: number
  height: number
  ocrText: string
  /** Mean OCR word confidence 0-100. */
  ocrConfidence: number
  quality: ScreenQuality
  qualityNote?: string
  /** Small JPEG data URL for the UI. */
  thumbnail?: string
  /** Path of the stored JPEG (vision input). Removed after the meeting unless screenshots are retained. */
  imagePath?: string
}

export type ResponseStatus = 'streaming' | 'done' | 'error' | 'cancelled'

export interface AssistantResponse {
  id: string
  action: AssistantAction
  /** The user's typed question (ask) or refinement instruction (refine). */
  prompt?: string
  text: string
  status: ResponseStatus
  provider: ProviderId
  model: string
  style: ResponseStyle
  at: number
  error?: string
  /** Notes shown under the answer, e.g. "Screen text was partially unreadable". */
  notes?: string[]
  screenId?: string
  usedImage?: boolean
  parentId?: string
  questionId?: string
  auto?: boolean
  /** Milliseconds from the request (click, shortcut or detected question) to the first words. */
  firstTokenMs?: number
  /** Milliseconds until the response was complete. */
  totalMs?: number
}

export interface DetectedQuestion {
  id: string
  segmentId: string
  text: string
  speaker: string
  at: number
  score: number
  status: 'open' | 'answered' | 'dismissed'
}

export interface MeetingSummary {
  overview: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  openQuestions: string[]
  updatedAt: number
  /** Raw Markdown as produced by the model (rendered in the UI). */
  markdown: string
}

export type SessionState = 'idle' | 'starting' | 'running' | 'paused' | 'stopping'

/**
 * What Auto answer mode is doing with the screen: `off` (Manual mode or screen answers disabled),
 * `waiting` (no meeting running), `no-source`, `paused`, `watching` (no change), `settling` (the
 * screen changed; waiting for it to stop changing), `reading` (capture + OCR), `answering`,
 * `nothing` (nothing on screen needs an answer, or it was answered already) and `unreadable`.
 */
export type ScreenWatchState = 'off' | 'waiting' | 'no-source' | 'paused' | 'watching' | 'settling' | 'reading' | 'answering' | 'nothing' | 'unreadable'

export interface AutoAnswerStatus {
  /** Automatic answering paused by the user (Auto mode stays selected). */
  paused: boolean
  screen: ScreenWatchState
  /** Extra detail for the current state, e.g. why the screen is unreadable. */
  detail?: string
}

export interface ChannelStatus {
  enabled: boolean
  active: boolean
  label?: string
  error?: string
}

export interface CaptureStatus {
  session: SessionState
  meetingId?: string
  meetingTitle?: string
  startedAt?: number
  mode: MeetingMode
  mic: ChannelStatus
  system: ChannelStatus
  screen: ChannelStatus & {
    sourceId?: string
    sourceName?: string
    sourceKind?: 'screen' | 'window'
    region?: Rect
    auto: boolean
    intervalSec: number
    lastCaptureAt?: number
    busy: boolean
  }
  transcription: {
    engine: TranscriptionEngineId
    model: string
    pending: number
    ok: boolean
    error?: string
    /** e.g. "Downloading Whisper model 42%" */
    detail?: string
  }
  ai: {
    provider: ProviderId
    model: string
    configured: boolean
    busy: boolean
    vision: boolean
  }
  autoAnswer: AutoAnswerStatus
}

export interface AudioLevels {
  mic: number
  system: number
  micSpeaking: boolean
  systemSpeaking: boolean
}

export interface MeetingRecordMeta {
  id: string
  title: string
  mode: MeetingMode
  startedAt: number
  endedAt?: number
  durationMs: number
  segmentCount: number
  provider: ProviderId
  model: string
  hasSummary: boolean
}

export interface MeetingRecord extends MeetingRecordMeta {
  segments: TranscriptSegment[]
  responses: AssistantResponse[]
  questions: DetectedQuestion[]
  snapshots: ScreenSnapshot[]
  summary?: MeetingSummary
  /** Rolling summary of early discussion used to keep long meetings within context limits. */
  rollingSummary?: string
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  displayId?: string
  thumbnail: string
  appIcon?: string
}

export interface AudioDevice {
  deviceId: string
  label: string
  isDefault: boolean
}

export interface Toast {
  id: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
  at: number
}

export type ShortcutAction =
  | 'toggleOverlay'
  | 'answer'
  | 'suggest'
  | 'explainScreen'
  | 'summarize'
  | 'captureScreen'
  | 'togglePause'
  | 'toggleAutoAnswer'
  | 'focusAsk'

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  toggleOverlay: 'Show / hide assistant panel',
  answer: 'Answer latest question',
  suggest: 'Questions to ask',
  explainScreen: 'Capture & explain screen',
  summarize: 'Summarize discussion',
  captureScreen: 'Capture screen now',
  togglePause: 'Pause / resume capture',
  toggleAutoAnswer: 'Pause / resume auto-answer',
  focusAsk: 'Ask anything (focus input)'
}
