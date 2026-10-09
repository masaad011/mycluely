import { z } from 'zod'
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, type Settings } from '@shared/settings'

const D = DEFAULT_SETTINGS
const provider = z.enum(['chatgpt', 'openai', 'anthropic', 'gemini', 'moonshot', 'deepseek'])
const modelId = (fallback: string) => z.string().trim().min(1).max(200).catch(fallback)
const num = (min: number, max: number, fallback: number) => z.number().finite().min(min).max(max).catch(fallback)
const bool = (fallback: boolean) => z.boolean().catch(fallback)

/**
 * Every field falls back to its default when missing or invalid, so a hand-edited or older
 * settings file can never crash the app or produce an unusable configuration.
 */
export const settingsSchema = z.object({
  version: z.literal(4).catch(4),
  ai: z
    .object({
      provider: provider.catch(D.ai.provider),
      models: z
        .object({
          chatgpt: modelId(D.ai.models.chatgpt),
          openai: modelId(D.ai.models.openai),
          anthropic: modelId(D.ai.models.anthropic),
          gemini: modelId(D.ai.models.gemini),
          moonshot: modelId(D.ai.models.moonshot),
          deepseek: modelId(D.ai.models.deepseek)
        })
        .catch(D.ai.models),
      visionOverrides: z.record(z.string(), z.boolean()).catch({}),
      baseUrls: z
        .object({
          openai: z.string().url().optional().catch(undefined),
          anthropic: z.string().url().optional().catch(undefined),
          gemini: z.string().url().optional().catch(undefined),
          moonshot: z.string().url().optional().catch(undefined),
          deepseek: z.string().url().optional().catch(undefined)
        })
        .catch({}),
      moonshotRegion: z.enum(['global', 'cn']).catch(D.ai.moonshotRegion),
      imagePolicy: z.enum(['never', 'auto', 'explain', 'always']).catch(D.ai.imagePolicy),
      speed: z.enum(['fast', 'balanced']).catch(D.ai.speed),
      maxContextTokens: num(2000, 400_000, D.ai.maxContextTokens),
      maxOutputTokens: num(256, 64_000, D.ai.maxOutputTokens),
      requestTimeoutSec: num(10, 600, D.ai.requestTimeoutSec)
    })
    .catch(D.ai),
  transcription: z
    .object({
      engine: z.enum(['auto', 'local', 'openai', 'gemini', 'none']).catch(D.transcription.engine),
      openaiModel: modelId(D.transcription.openaiModel),
      geminiModel: modelId(D.transcription.geminiModel),
      localModel: modelId(D.transcription.localModel),
      language: z.string().trim().max(10).catch(D.transcription.language),
      diarize: bool(D.transcription.diarize)
    })
    .catch(D.transcription),
  audio: z
    .object({
      micEnabled: bool(D.audio.micEnabled),
      micDeviceId: z.string().max(500).catch(D.audio.micDeviceId),
      systemEnabled: bool(D.audio.systemEnabled),
      vadSensitivity: num(0, 1, D.audio.vadSensitivity),
      minSilenceMs: num(200, 3000, D.audio.minSilenceMs),
      maxSegmentSec: num(4, 28, D.audio.maxSegmentSec)
    })
    .catch(D.audio),
  screen: z
    .object({
      autoCapture: bool(D.screen.autoCapture),
      intervalSec: num(3, 600, D.screen.intervalSec),
      ocrEnabled: bool(D.screen.ocrEnabled),
      skipUnchanged: bool(D.screen.skipUnchanged)
    })
    .catch(D.screen),
  assistant: z
    .object({
      mode: z.enum(['general', 'technical', 'standup', 'client']).catch(D.assistant.mode),
      style: z.enum(['short', 'detailed', 'technical', 'conversational']).catch(D.assistant.style),
      autoSuggest: z.enum(['off', 'questions', 'answers']).catch(D.assistant.autoSuggest),
      suggestionCooldownSec: num(5, 600, D.assistant.suggestionCooldownSec),
      autoScreen: bool(D.assistant.autoScreen),
      customInstructions: z.string().max(4000).catch(''),
      userContext: z.string().max(1000).catch('')
    })
    .catch(D.assistant),
  privacy: z
    .object({
      saveHistory: bool(D.privacy.saveHistory),
      retentionDays: num(0, 3650, D.privacy.retentionDays),
      keepScreenshots: bool(D.privacy.keepScreenshots),
      consentReminder: bool(D.privacy.consentReminder),
      hideFromCapture: bool(D.privacy.hideFromCapture)
    })
    .catch(D.privacy),
  ui: z
    .object({
      theme: z.enum(['system', 'light', 'paper', 'dark', 'midnight', 'slate', 'black', 'contrast']).catch(D.ui.theme),
      accent: z.enum(['system', 'blue', 'indigo', 'violet', 'teal', 'green', 'amber', 'rose', 'graphite']).catch(D.ui.accent),
      density: z.enum(['comfortable', 'compact']).catch(D.ui.density),
      corners: z.enum(['rounded', 'square']).catch(D.ui.corners),
      font: z.enum(['segoe', 'bahnschrift', 'calibri', 'cascadia']).catch(D.ui.font),
      layout: z
        .object({
          leftWidth: num(0.2, 0.8, D.ui.layout.leftWidth),
          transcriptHeight: num(0.15, 0.85, D.ui.layout.transcriptHeight),
          historyWidth: num(220, 640, D.ui.layout.historyWidth),
          collapsed: z
            .object({ transcript: bool(false), screen: bool(false), assistant: bool(false) })
            .catch(D.ui.layout.collapsed),
          maximized: z.enum(['transcript', 'screen', 'assistant']).nullable().catch(null)
        })
        .catch(D.ui.layout),
      overlayAlwaysOnTop: bool(D.ui.overlayAlwaysOnTop),
      overlayOpacity: num(0.3, 1, D.ui.overlayOpacity),
      showOverlayOnStart: bool(D.ui.showOverlayOnStart),
      showOverlayOnAutoAnswer: bool(D.ui.showOverlayOnAutoAnswer),
      fontScale: num(0.8, 1.6, D.ui.fontScale)
    })
    .catch(D.ui),
  shortcuts: z
    .object(
      Object.fromEntries(
        Object.entries(DEFAULT_SHORTCUTS).map(([k, v]) => [k, z.string().max(80).catch(v)])
      ) as Record<keyof typeof DEFAULT_SHORTCUTS, z.ZodCatch<z.ZodString>>
    )
    .catch(DEFAULT_SHORTCUTS)
})

/** Upgrade settings written by older versions before validation. */
function migrate(input: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(input)
  const version = typeof out.version === 'number' ? out.version : 1
  if (version < 2) {
    // v2: the screenshot policy gained 'auto'. 'explain' was the v1 default (rarely chosen on
    // purpose), so move it to the new default; explicit 'never'/'always' are kept.
    const ai = out.ai as Record<string, unknown> | undefined
    if (ai?.imagePolicy === 'explain') ai.imagePolicy = 'auto'
  }
  if (version < 3) {
    // v3: questions asked during the auto-answer cooldown are answered when it ends instead of
    // being skipped, so the old 30 s default would delay answers; move it to the new default.
    const assistant = out.assistant as Record<string, unknown> | undefined
    if (assistant?.suggestionCooldownSec === 30) assistant.suggestionCooldownSec = DEFAULT_SETTINGS.assistant.suggestionCooldownSec
  }
  if (version < 4) {
    // v4: MyCluely windows are now hidden from screen captures by default, so sharing your screen
    // in a meeting doesn't show the assistant to the other participants. Enable it once for
    // existing profiles (the old default was off); you can still turn it off in Privacy.
    const privacy: Record<string, unknown> = (out.privacy as Record<string, unknown> | undefined) ?? {}
    privacy.hideFromCapture = true
    out.privacy = privacy
  }
  out.version = 4
  return out
}

export function sanitizeSettings(input: unknown): Settings {
  const migrated = migrate((input && typeof input === 'object' ? input : {}) as Record<string, unknown>)
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>, migrated)
  return settingsSchema.parse(merged) as Settings
}

/** Merge `patch` into `base` (objects recursively, everything else replaced). */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}
