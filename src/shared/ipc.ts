import type { DeepPartial, Settings } from './settings'
import type { ThemeId } from './themes'
import type {
  AssistantAction,
  AssistantResponse,
  AudioDevice,
  AudioLevels,
  AudioSourceKind,
  CaptureSource,
  CaptureStatus,
  CredentialStatus,
  DetectedQuestion,
  MeetingMode,
  MeetingRecord,
  MeetingRecordMeta,
  MeetingSummary,
  ModelInfo,
  ProviderId,
  ProviderTestResult,
  Rect,
  ResponseStyle,
  ScreenSnapshot,
  Toast,
  TranscriptSegment
} from './types'

/** The theme in effect (Settings → Appearance, or Windows when set to System) and the Windows accent colour. */
export interface ThemeState {
  id: ThemeId
  /** Windows accent colour as #rrggbb, for the "Windows accent" option. */
  systemAccent?: string
}

/** Full live state, sent to a window when it (re)loads. */
export interface AppSnapshot {
  status: CaptureStatus
  segments: TranscriptSegment[]
  responses: AssistantResponse[]
  questions: DetectedQuestion[]
  snapshots: ScreenSnapshot[]
  summary?: MeetingSummary
  settings: Settings
  credentials: Record<ProviderId, CredentialStatus>
  devices: AudioDevice[]
  platform: NodeJS.Platform
  version: string
  theme: ThemeState
}

export interface RunActionRequest {
  action: AssistantAction
  prompt?: string
  questionId?: string
  style?: ResponseStyle
}

/**
 * Request/response calls from UI windows to the main process. Keys are IPC channel names; the
 * preload exposes them through a single whitelisted `invoke`.
 */
export interface InvokeMap {
  'app:snapshot': { args: []; result: AppSnapshot }
  'settings:get': { args: []; result: Settings }
  'settings:update': { args: [patch: DeepPartial<Settings>]; result: Settings }
  'settings:reset': { args: []; result: Settings }
  'credentials:status': { args: []; result: Record<ProviderId, CredentialStatus> }
  'credentials:set': { args: [provider: ProviderId, apiKey: string]; result: Record<ProviderId, CredentialStatus> }
  'credentials:clear': { args: [provider: ProviderId]; result: Record<ProviderId, CredentialStatus> }
  'chatgpt:sign-in': { args: []; result: Record<ProviderId, CredentialStatus> }
  'chatgpt:cancel': { args: []; result: void }
  'chatgpt:sign-out': { args: [forgetAccount?: boolean]; result: { revoked: boolean } }
  'providers:test': { args: [provider: ProviderId]; result: ProviderTestResult }
  'providers:models': { args: [provider: ProviderId, refresh?: boolean]; result: ModelInfo[] }
  'session:start': { args: [opts: { title?: string; mode?: MeetingMode }]; result: void }
  'session:pause': { args: []; result: void }
  'session:resume': { args: []; result: void }
  'session:stop': { args: []; result: void }
  'session:rename': { args: [title: string]; result: void }
  'session:set-mode': { args: [mode: MeetingMode]; result: void }
  'screen:sources': { args: []; result: CaptureSource[] }
  'screen:select': { args: [sourceId: string | null]; result: void }
  'screen:select-region': { args: []; result: Rect | null }
  'screen:clear-region': { args: []; result: void }
  'screen:capture': { args: []; result: ScreenSnapshot | null }
  'screen:auto': { args: [enabled: boolean, intervalSec?: number]; result: void }
  'assistant:run': { args: [req: RunActionRequest]; result: string }
  'assistant:regenerate': { args: [responseId: string]; result: string }
  'assistant:refine': { args: [responseId: string, instruction: string]; result: string }
  'assistant:cancel': { args: [responseId: string]; result: void }
  'questions:dismiss': { args: [id: string]; result: void }
  'auto:set-paused': { args: [paused: boolean]; result: void }
  'history:list': { args: []; result: MeetingRecordMeta[] }
  'history:get': { args: [id: string]; result: MeetingRecord | null }
  'history:delete': { args: [id: string]; result: void }
  'history:delete-all': { args: []; result: void }
  'history:export': { args: [id: string, format: 'md' | 'txt']; result: string | null }
  'window:toggle-overlay': { args: []; result: void }
  'window:show-main': { args: [view?: 'live' | 'history' | 'settings']; result: void }
  'window:hide-overlay': { args: []; result: void }
  'window:set-overlay-top': { args: [onTop: boolean]; result: void }
  /** Collapse the panel window to its title bar (height in px), or restore it. Returns the new state. */
  'window:overlay-collapse': { args: [collapsed: boolean, barHeight: number]; result: boolean }
  'clipboard:write': { args: [text: string]; result: void }
  'shell:open-external': { args: [url: string]; result: void }
  'region:done': { args: [rect: Rect | null]; result: void }
}

/** Events pushed from main to UI windows. */
export interface EventMap {
  status: CaptureStatus
  segment: TranscriptSegment
  response: AssistantResponse
  'response-delta': { id: string; delta: string }
  questions: DetectedQuestion[]
  snapshot: ScreenSnapshot
  summary: MeetingSummary
  levels: AudioLevels
  toast: Toast
  settings: Settings
  credentials: Record<ProviderId, CredentialStatus>
  devices: AudioDevice[]
  'session-reset': AppSnapshot
  'focus-ask': null
  navigate: 'live' | 'history' | 'settings'
  'region-init': { displayLabel: string }
  theme: ThemeState
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS = [
  'app:snapshot',
  'settings:get',
  'settings:update',
  'settings:reset',
  'credentials:status',
  'credentials:set',
  'credentials:clear',
  'chatgpt:sign-in',
  'chatgpt:cancel',
  'chatgpt:sign-out',
  'providers:test',
  'providers:models',
  'session:start',
  'session:pause',
  'session:resume',
  'session:stop',
  'session:rename',
  'session:set-mode',
  'screen:sources',
  'screen:select',
  'screen:select-region',
  'screen:clear-region',
  'screen:capture',
  'screen:auto',
  'assistant:run',
  'assistant:regenerate',
  'assistant:refine',
  'assistant:cancel',
  'questions:dismiss',
  'auto:set-paused',
  'history:list',
  'history:get',
  'history:delete',
  'history:delete-all',
  'history:export',
  'window:toggle-overlay',
  'window:show-main',
  'window:hide-overlay',
  'window:set-overlay-top',
  'window:overlay-collapse',
  'clipboard:write',
  'shell:open-external',
  'region:done'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'status',
  'segment',
  'response',
  'response-delta',
  'questions',
  'snapshot',
  'summary',
  'levels',
  'toast',
  'settings',
  'credentials',
  'devices',
  'session-reset',
  'focus-ask',
  'navigate',
  'region-init',
  'theme'
] as const satisfies readonly EventChannel[]

// ---------------------------------------------------------------------------------------------
// Capture engine (hidden renderer) <-> main

export interface AudioCaptureConfig {
  micEnabled: boolean
  micDeviceId: string
  systemEnabled: boolean
  vadSensitivity: number
  minSilenceMs: number
  maxSegmentSec: number
}

export type CaptureCommand =
  | { type: 'start'; audio: AudioCaptureConfig }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'configure'; audio: AudioCaptureConfig }
  | { type: 'refresh-devices' }

export interface GrabRequest {
  requestId: string
  sourceId: string
  sourceKind: 'screen' | 'window'
  /** Crop as fractions (0..1) of the source frame. */
  region?: Rect
  /** Areas to black out (our own windows), as fractions of the source frame. */
  masks: Rect[]
  /** Change check only: return the signature and blankness, skip encoding images. */
  probe?: boolean
}

export interface GrabResult {
  requestId: string
  ok: boolean
  error?: string
  width?: number
  height?: number
  /** Lossless image for OCR (upscaled for small text). */
  ocrPng?: Uint8Array
  /** JPEG for vision models (long side ≤ 1600 px). */
  visionJpeg?: Uint8Array
  thumbnail?: string
  /** 160x90 grayscale thumbnail for change detection (see isScreenChanged). */
  signature?: Uint8Array
  /** Fraction of near-uniform pixels: ~1 means a blank/black frame. */
  blankness?: number
}

export interface AudioSegmentMessage {
  source: AudioSourceKind
  /** Epoch ms of the first sample. */
  startedAt: number
  durationMs: number
  peakDb: number
  wav: Uint8Array
}

export interface ChannelStatusMessage {
  channel: 'mic' | 'system'
  active: boolean
  label?: string
  error?: string
}

export interface LocalSttRequest {
  requestId: string
  model: string
  language?: string
  wav: Uint8Array
}

export interface LocalSttResult {
  requestId: string
  ok: boolean
  text?: string
  error?: string
}

export interface LocalSttProgress {
  status: 'loading' | 'ready' | 'error'
  /** 0..100 while downloading/initialising. */
  progress?: number
  device?: string
  message?: string
}

/** Channels used only by the capture window. */
export const CAPTURE_SEND_CHANNELS = [
  'capture:segment',
  'capture:levels',
  'capture:channel',
  'capture:devices',
  'capture:grab-result',
  'capture:ready',
  'local-stt:result',
  'local-stt:progress',
  'capture:log'
] as const

export const CAPTURE_RECEIVE_CHANNELS = ['capture:command', 'capture:grab', 'local-stt:transcribe'] as const
