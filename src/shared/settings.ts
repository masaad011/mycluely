import type {
  MeetingMode,
  ProviderId,
  ResponseStyle,
  ShortcutAction,
  TranscriptionEngineId
} from './types'

export type AutoSuggestMode = 'off' | 'questions' | 'answers'
/** When to attach the screenshot itself for vision models. `auto`: for Explain screen, and when OCR text is not clear. */
export type ImagePolicy = 'never' | 'auto' | 'explain' | 'always'
/** `system` follows the Windows light/dark app setting. */
/**
 * `fast`: no extended thinking for live answers and screenshots only for Explain screen.
 * `balanced`: thinks longer for Detailed/Technical answers and sends screenshots when screen text is hard to read.
 */
export type ResponseSpeed = 'fast' | 'balanced'
import type { AccentId, Corners, Density, FontId, ThemePreference } from './themes'

export interface Settings {
  version: 3
  ai: {
    provider: ProviderId
    /** Selected model per provider so switching providers keeps each choice. */
    models: Record<ProviderId, string>
    /** User overrides for image support keyed by `${provider}:${model}`. */
    visionOverrides: Record<string, boolean>
    /** Optional base URL overrides (proxies, Azure-compatible gateways, test servers). */
    baseUrls: Partial<Record<ProviderId, string>>
    moonshotRegion: 'global' | 'cn'
    /** When to attach the screenshot itself (vision models only). OCR text is always included. */
    imagePolicy: ImagePolicy
    /** Latency/quality trade-off for assistant responses. */
    speed: ResponseSpeed
    /** Upper bound on context tokens sent per request (transcript + screen + history). */
    maxContextTokens: number
    /** Maximum output tokens per assistant response. */
    maxOutputTokens: number
    requestTimeoutSec: number
  }
  transcription: {
    engine: TranscriptionEngineId
    openaiModel: string
    geminiModel: string
    localModel: string
    /** ISO-639-1 language hint, '' = auto-detect. */
    language: string
    /** Ask the engine to separate speakers inside system-audio segments when supported. */
    diarize: boolean
  }
  audio: {
    micEnabled: boolean
    micDeviceId: string
    systemEnabled: boolean
    /** 0 (only loud speech) .. 1 (very sensitive). */
    vadSensitivity: number
    minSilenceMs: number
    maxSegmentSec: number
  }
  screen: {
    autoCapture: boolean
    intervalSec: number
    ocrEnabled: boolean
    /** Skip automatic captures that look identical to the previous one. */
    skipUnchanged: boolean
  }
  assistant: {
    mode: MeetingMode
    style: ResponseStyle
    /** `answers` = auto-answer questions from other participants; `questions` = highlight them, the user clicks Answer. */
    autoSuggest: AutoSuggestMode
    /** Minimum seconds between automatic answers (a question asked sooner is answered when it ends). */
    suggestionCooldownSec: number
    /** In Auto mode, also watch the selected screen/window/region and answer questions shown there. */
    autoScreen: boolean
    customInstructions: string
    /** Your name/role so answers can be written in your voice. */
    userContext: string
  }
  privacy: {
    saveHistory: boolean
    /** Delete saved meetings older than this many days. 0 = keep forever. */
    retentionDays: number
    keepScreenshots: boolean
    consentReminder: boolean
    /** Exclude MyCluely windows from screenshots and screen sharing (Windows 10 2004+). */
    hideFromCapture: boolean
  }
  ui: {
    theme: ThemePreference
    accent: AccentId
    density: Density
    corners: Corners
    font: FontId
    overlayAlwaysOnTop: boolean
    overlayOpacity: number
    showOverlayOnStart: boolean
    /** Bring up the assistant panel (without taking focus) when an automatic answer arrives. */
    showOverlayOnAutoAnswer: boolean
    fontScale: number
  }
  shortcuts: Record<ShortcutAction, string>
}

/**
 * Defaults avoid combinations owned by meeting apps and editors (Teams uses Ctrl+Shift+M/E/K/…,
 * VS Code Ctrl+Shift+E/P/…) and avoid Ctrl+Alt+letter, which is AltGr on many keyboard layouts
 * (it would block typing @, €, ą … system-wide). Action shortcuts are only registered while a
 * meeting is live; only the panel toggle is always active.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  toggleOverlay: 'CommandOrControl+Alt+Space',
  answer: 'CommandOrControl+Alt+Enter',
  suggest: 'CommandOrControl+Alt+Shift+Q',
  explainScreen: 'CommandOrControl+Alt+Shift+E',
  summarize: 'CommandOrControl+Alt+Shift+S',
  captureScreen: 'CommandOrControl+Alt+Shift+C',
  togglePause: 'CommandOrControl+Alt+Shift+P',
  toggleAutoAnswer: 'CommandOrControl+Alt+Shift+W',
  focusAsk: 'CommandOrControl+Alt+Shift+A'
}

/** Shortcuts that stay registered when no meeting is running. */
export const ALWAYS_ON_SHORTCUTS: ShortcutAction[] = ['toggleOverlay']

/**
 * Defaults are suggestions only: the model lists in Settings are fetched live from each
 * provider, and any model id the provider returns can be selected (or typed manually).
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 3,
  ai: {
    provider: 'anthropic',
    models: {
      chatgpt: 'gpt-6.1-sol',
      openai: 'gpt-6.1-sol',
      anthropic: 'claude-opus-5-5',
      gemini: 'gemini-3.8-flash',
      moonshot: 'kimi-k2.6',
      deepseek: 'deepseek-flash'
    },
    visionOverrides: {},
    baseUrls: {},
    moonshotRegion: 'global',
    imagePolicy: 'auto',
    speed: 'fast',
    maxContextTokens: 24000,
    maxOutputTokens: 4096,
    requestTimeoutSec: 90
  },
  transcription: {
    engine: 'auto',
    openaiModel: 'gpt-transcribe',
    geminiModel: 'gemini-3.5-flash-lite',
    localModel: 'onnx-community/whisper-base.en',
    language: 'en',
    diarize: false
  },
  audio: {
    micEnabled: true,
    micDeviceId: 'default',
    systemEnabled: true,
    vadSensitivity: 0.6,
    minSilenceMs: 700,
    maxSegmentSec: 14
  },
  screen: {
    autoCapture: false,
    intervalSec: 20,
    ocrEnabled: true,
    skipUnchanged: true
  },
  assistant: {
    mode: 'general',
    style: 'short',
    autoSuggest: 'questions',
    suggestionCooldownSec: 10,
    autoScreen: true,
    customInstructions: '',
    userContext: ''
  },
  privacy: {
    saveHistory: true,
    retentionDays: 30,
    keepScreenshots: false,
    consentReminder: true,
    hideFromCapture: false
  },
  ui: {
    theme: 'system',
    accent: 'blue',
    density: 'comfortable',
    corners: 'rounded',
    font: 'segoe',
    overlayAlwaysOnTop: true,
    overlayOpacity: 0.96,
    showOverlayOnStart: true,
    showOverlayOnAutoAnswer: true,
    fontScale: 1
  },
  shortcuts: { ...DEFAULT_SHORTCUTS }
}

export const CAPTURE_INTERVAL_CHOICES = [5, 10, 20, 30, 60, 120]

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K]
}
