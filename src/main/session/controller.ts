import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AppSnapshot, AudioCaptureConfig, AudioSegmentMessage, ChannelStatusMessage, GrabRequest, RunActionRequest, ThemeState } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type {
  AudioDevice,
  AudioLevels,
  CaptureSource,
  CaptureStatus,
  CredentialStatus,
  MeetingMode,
  ProviderId,
  Rect,
  ScreenSnapshot,
  ScreenWatchState,
  Toast,
  TranscriptSegment
} from '@shared/types'
import { resolveVision } from '@shared/models'
import { assessScreenQuality, intersect, isScreenChanged, toFractions } from '@shared/screen'
import { cleanTranscriptText, isEchoOfRemote, isLikelyHallucination } from '@shared/transcript'
import { newId } from '@shared/util'
import { AssistantService } from '../assistant/assistant'
import type { ProviderRegistry } from '../providers/registry'
import type { MeetingStore } from '../services/meeting-store'
import { TranscriptionService } from '../transcription/service'
import { LiveMeeting } from './live-meeting'
import { ScreenWatcher, type ScreenWatcherTimings } from './screen-watcher'
import type { Broadcaster, CaptureDriver, ScreenSourceProvider } from './ports'

export interface OcrEngine {
  recognize(image: Uint8Array): Promise<{ text: string; confidence: number; confidentShare?: number }>
}

export interface SessionDeps {
  settings: () => Settings
  registry: ProviderRegistry
  credentials: () => Promise<Record<ProviderId, CredentialStatus>>
  store: MeetingStore
  capture: CaptureDriver
  screens: ScreenSourceProvider
  ocr: OcrEngine
  broadcaster: Broadcaster
  /** Folder for screenshots that are not retained after the meeting. */
  cacheDir: string
  platform?: NodeJS.Platform
  version?: string
  /** Theme in effect for UI windows. */
  theme?: () => ThemeState
  /** An automatic answer appeared (e.g. bring up the answer panel). */
  onAutoAnswer?: () => void
  /** Screen watching intervals (tests use shorter ones). */
  watcherTimings?: Partial<ScreenWatcherTimings>
}

/** A spoken question this recent is what Answer answers; otherwise it also looks at the screen. */
const SPOKEN_QUESTION_MS = 2 * 60_000

const SAVE_DEBOUNCE_MS = 3000

/**
 * Orchestrates a meeting: capture lifecycle, transcription, question tracking, screen context,
 * assistant actions and persistence. Contains no Electron code so the whole workflow can be
 * exercised headlessly in tests.
 */
export class SessionController extends EventEmitter {
  private live: LiveMeeting
  readonly transcription: TranscriptionService
  readonly assistant: AssistantService
  readonly screenWatcher: ScreenWatcher
  private status: CaptureStatus
  /** Automatic answering paused by the user (Auto mode stays selected). */
  private autoPaused = false
  private levels: AudioLevels = { mic: 0, system: 0, micSpeaking: false, systemSpeaking: false }
  private devices: AudioDevice[] = []
  private selectedSource: CaptureSource | null = null
  private capturing: Promise<ScreenSnapshot | null> | null = null
  /** Change signature of the last capture that was actually read (OCR'd). */
  private lastSignature: Uint8Array | undefined
  private autoTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private inflightSegments = new Set<Promise<void>>()

  constructor(private readonly deps: SessionDeps) {
    super()
    const s = deps.settings()
    this.live = new LiveMeeting({
      mode: s.assistant.mode,
      provider: s.ai.provider,
      model: s.ai.models[s.ai.provider],
      persist: false,
      started: false
    })
    this.status = {
      session: 'idle',
      mode: s.assistant.mode,
      mic: { enabled: s.audio.micEnabled, active: false },
      system: { enabled: s.audio.systemEnabled, active: false },
      screen: {
        enabled: true,
        active: false,
        auto: s.screen.autoCapture,
        intervalSec: s.screen.intervalSec,
        busy: false
      },
      transcription: { engine: s.transcription.engine, model: '', pending: 0, ok: true },
      ai: { provider: s.ai.provider, model: s.ai.models[s.ai.provider], configured: false, busy: false, vision: false },
      autoAnswer: { paused: false, screen: 'off' }
    }
    this.transcription = new TranscriptionService(
      deps.registry,
      deps.settings,
      deps.capture,
      (t) => this.patchStatus({ transcription: { ...this.status.transcription, ...t } }),
      (msg) => this.toast('warning', msg)
    )
    this.assistant = new AssistantService(deps.registry, deps.settings, () => this.live, {
      response: (r) => deps.broadcaster.send('response', r),
      delta: (id, delta) => deps.broadcaster.send('response-delta', { id, delta }),
      summary: (s2) => deps.broadcaster.send('summary', s2),
      questions: (q) => deps.broadcaster.send('questions', q),
      toast: (level, message) => this.toast(level, message),
      busy: (busy) => this.patchStatus({ ai: { ...this.status.ai, busy } }),
      changed: () => this.scheduleSave(),
      autoAnswer: () => deps.onAutoAnswer?.()
    }, () => (this.status.session === 'running' || this.status.session === 'paused') && !this.autoPaused)
    this.screenWatcher = new ScreenWatcher(
      {
        probe: () => this.probeScreen(),
        capture: () => this.captureScreen('auto'),
        answer: () => this.answerScreen(),
        seesImages: () => this.status.ai.vision && this.deps.settings().ai.imagePolicy !== 'never',
        busy: () => this.assistant.busy,
        cooldownMs: () => this.deps.settings().assistant.suggestionCooldownSec * 1000,
        setState: (screen, detail) => this.setAutoState(screen, detail)
      },
      deps.watcherTimings
    )
  }

  // ------------------------------------------------------------------ state & events

  get meeting(): LiveMeeting {
    return this.live
  }

  getStatus(): CaptureStatus {
    return this.status
  }

  async snapshot(): Promise<AppSnapshot> {
    return {
      status: this.status,
      segments: this.live.record.segments,
      responses: this.live.record.responses,
      questions: this.live.questions,
      snapshots: this.live.record.snapshots,
      summary: this.live.record.summary,
      settings: this.deps.settings(),
      credentials: await this.deps.credentials(),
      devices: this.devices,
      platform: this.deps.platform ?? process.platform,
      version: this.deps.version ?? '0.0.0',
      theme: this.deps.theme?.() ?? { id: 'dark' }
    }
  }

  private patchStatus(patch: Partial<CaptureStatus>): void {
    const prev = this.status.session
    this.status = { ...this.status, ...patch }
    this.deps.broadcaster.send('status', this.status)
    if (this.status.session !== prev) {
      this.emit('session', this.status.session)
      this.updateWatcher()
    }
  }

  setTranscriptionDetail(detail?: string): void {
    this.patchStatus({ transcription: { ...this.status.transcription, detail } })
  }

  toast(level: Toast['level'], message: string, detail?: string): void {
    this.deps.broadcaster.send('toast', { id: newId('t'), level, message, detail, at: Date.now() })
  }

  /** Re-evaluate provider/model/transcription status after settings or credentials change. */
  private refreshSeq = 0

  /** Auto-answer was switched on or off: answer a question that was just asked, or drop a pending one. */
  autoAnswerChanged(): void {
    if (this.deps.settings().assistant.autoSuggest === 'answers') this.assistant.onQuestionDetected()
    else this.assistant.stopAuto()
    this.updateWatcher()
  }

  get autoAnswerPaused(): boolean {
    return this.autoPaused
  }

  /** Pause or resume automatic answering (spoken and on-screen questions); Auto mode stays selected. */
  setAutoPaused(paused: boolean): void {
    if (this.autoPaused === paused) return
    this.autoPaused = paused
    if (paused) this.assistant.stopAuto()
    this.patchStatus({ autoAnswer: { ...this.status.autoAnswer, paused } })
    this.updateWatcher()
    if (!paused) this.assistant.onQuestionDetected()
  }

  private setAutoState(screen: ScreenWatchState, detail?: string): void {
    const cur = this.status.autoAnswer
    if (cur.screen === screen && cur.detail === detail) return
    this.patchStatus({ autoAnswer: { ...cur, screen, detail } })
  }

  /** Watch the screen only in Auto mode, while a meeting runs, not paused, with something selected. */
  private updateWatcher(): void {
    if (!this.screenWatcher) return // during construction
    const a = this.deps.settings().assistant
    let state: ScreenWatchState | null = null
    if (a.autoSuggest !== 'answers' || !a.autoScreen) state = 'off'
    else if (this.status.session !== 'running') state = this.status.session === 'paused' ? 'paused' : 'waiting'
    else if (this.autoPaused) state = 'paused'
    else if (!this.selectedSource) state = 'no-source'
    if (state) {
      this.screenWatcher.stop()
      this.setAutoState(state)
    } else {
      this.screenWatcher.start()
    }
    // The watcher reads the screen whenever it changes, so periodic capture is not needed meanwhile.
    this.scheduleAutoCapture()
  }

  private async probeScreen(): Promise<{ ok: boolean; signature?: Uint8Array; error?: string }> {
    const src = this.selectedSource
    if (!src) return { ok: false, error: 'No screen or window selected.' }
    const res = await this.deps.capture.grab({ ...this.grabTarget(src), probe: true }, 10_000)
    return { ok: res.ok, signature: res.signature, error: res.error }
  }

  /** Answer what is on the latest capture; quiet, so "nothing to answer" never shows a card. */
  private async answerScreen(): Promise<'answered' | 'nothing' | 'failed'> {
    if (!(await this.deps.registry.isConfigured(this.deps.settings().ai.provider))) return 'failed'
    const live = this.live
    const id = this.assistant.run({ action: 'screen-answer', auto: true, quiet: true })
    await this.assistant.wait(id)
    const r = live.findResponse(id)
    return !r ? 'nothing' : r.status === 'done' ? 'answered' : 'failed'
  }

  async refreshStatus(): Promise<void> {
    const seq = ++this.refreshSeq
    const s = this.deps.settings()
    const provider = s.ai.provider
    const model = s.ai.models[provider]
    const configured = await this.deps.registry.isConfigured(provider)
    const info = configured ? await this.deps.registry.modelInfo(provider, model) : undefined
    // A newer refresh started while we were waiting on the network: let it win.
    if (seq !== this.refreshSeq) return
    const { vision } = resolveVision(info, provider, model, s.ai.visionOverrides)
    this.patchStatus({
      // While idle the selector shows the type the next meeting will use.
      mode: this.status.session === 'idle' ? s.assistant.mode : this.live.record.mode,
      ai: { ...this.status.ai, provider, model, configured, vision },
      mic: { ...this.status.mic, enabled: s.audio.micEnabled },
      system: { ...this.status.system, enabled: s.audio.systemEnabled },
      screen: { ...this.status.screen, auto: s.screen.autoCapture, intervalSec: s.screen.intervalSec }
    })
    await this.transcription.publish()
    if (this.status.session === 'running') {
      this.deps.capture.command({ type: 'configure', audio: this.audioConfig() })
      this.scheduleAutoCapture()
    }
    this.updateWatcher()
  }

  private audioConfig(): AudioCaptureConfig {
    const a = this.deps.settings().audio
    return {
      micEnabled: a.micEnabled,
      micDeviceId: a.micDeviceId,
      systemEnabled: a.systemEnabled,
      vadSensitivity: a.vadSensitivity,
      minSilenceMs: a.minSilenceMs,
      maxSegmentSec: a.maxSegmentSec
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async start(opts: { title?: string; mode?: MeetingMode } = {}): Promise<void> {
    if (this.status.session !== 'idle') {
      if (this.status.session === 'stopping') this.toast('info', 'Still finishing the previous meeting — try again in a moment.')
      return
    }
    const s = this.deps.settings()
    this.transcription.reset()
    this.assistant.cancelAll()
    // Get the first answer off to a quick start: open the connection and load model metadata now.
    this.deps.registry.warm(s.ai.provider)
    void this.deps.registry.modelInfo(s.ai.provider, s.ai.models[s.ai.provider])
    this.live = new LiveMeeting({
      title: opts.title,
      mode: opts.mode ?? s.assistant.mode,
      provider: s.ai.provider,
      model: s.ai.models[s.ai.provider],
      persist: s.privacy.saveHistory,
      started: true
    })
    this.lastSignature = undefined
    this.screenWatcher.clearHistory()
    this.patchStatus({
      session: 'starting',
      meetingId: this.live.id,
      meetingTitle: this.live.record.title,
      startedAt: this.live.record.startedAt,
      mode: this.live.record.mode,
      mic: { enabled: s.audio.micEnabled, active: false },
      system: { enabled: s.audio.systemEnabled, active: false }
    })
    this.deps.broadcaster.send('session-reset', await this.snapshot())
    this.deps.capture.command({ type: 'start', audio: this.audioConfig() })
    this.patchStatus({ session: 'running' })
    await this.saveNow()
    this.scheduleAutoCapture()
    this.emit('started')
    if (s.screen.autoCapture && this.selectedSource) void this.captureScreen('auto')
  }

  pause(): void {
    if (this.status.session !== 'running') return
    this.deps.capture.command({ type: 'pause' })
    this.clearAutoCapture()
    this.patchStatus({ session: 'paused' })
  }

  resume(): void {
    if (this.status.session !== 'paused') return
    this.deps.capture.command({ type: 'resume' })
    this.patchStatus({ session: 'running' })
    this.scheduleAutoCapture()
  }

  togglePause(): void {
    if (this.status.session === 'running') this.pause()
    else if (this.status.session === 'paused') this.resume()
  }

  async stop(): Promise<void> {
    if (this.status.session !== 'running' && this.status.session !== 'paused') return
    const live = this.live
    this.clearAutoCapture()
    this.assistant.stopAuto()
    this.deps.capture.command({ type: 'stop' })
    this.patchStatus({ session: 'stopping' })
    // The capture engine flushes the utterance in progress on stop; give it a moment to arrive,
    // then let the last utterances finish transcribing.
    await new Promise((r) => setTimeout(r, 800))
    await Promise.race([Promise.allSettled([...this.inflightSegments]), new Promise((r) => setTimeout(r, 20_000))])

    const s = this.deps.settings()
    const ok = live.record.segments.filter((x) => x.status === 'ok')
    if (ok.length >= 2 && (await this.deps.registry.isConfigured(s.ai.provider))) {
      const id = this.assistant.run({ action: 'summarize', auto: true })
      await Promise.race([this.assistant.wait(id), new Promise((r) => setTimeout(r, 120_000))])
    }
    live.record.endedAt = Date.now()
    live.record.durationMs = live.record.endedAt - live.record.startedAt
    live.record.provider = s.ai.provider
    live.record.model = s.ai.models[s.ai.provider]
    if (!s.privacy.keepScreenshots || !live.persist) await this.discardScreenshots(live)
    await this.saveNow(live)
    if (this.live !== live) return
    this.patchStatus({
      session: 'idle',
      mic: { ...this.status.mic, active: false },
      system: { ...this.status.system, active: false }
    })
    this.emit('stopped', live.id)
    if (live.persist) this.toast('success', 'Meeting saved to history.')
  }

  async rename(title: string): Promise<void> {
    this.live.record.title = title.trim() || this.live.record.title
    this.patchStatus({ meetingTitle: this.live.record.title })
    this.scheduleSave()
  }

  setMode(mode: MeetingMode): void {
    this.live.record.mode = mode
    this.patchStatus({ mode })
    this.scheduleSave()
  }

  // ------------------------------------------------------------------ capture engine events

  onLevels(levels: AudioLevels): void {
    this.levels = levels
    this.deps.broadcaster.send('levels', levels)
  }

  onChannel(msg: ChannelStatusMessage): void {
    const prev = this.status[msg.channel]
    const next = { ...prev, active: msg.active, label: msg.label ?? prev.label, error: msg.error }
    if (msg.error && msg.error !== prev.error) this.toast('warning', msg.error)
    this.patchStatus({ [msg.channel]: next } as Partial<CaptureStatus>)
  }

  onDevices(devices: AudioDevice[]): void {
    this.devices = devices
    this.deps.broadcaster.send('devices', devices)
  }

  onAudioSegment(msg: AudioSegmentMessage): void {
    const live = this.live
    if (!live.started || this.status.session === 'idle') return
    const p = this.handleSegment(live, msg).catch((err) => {
      this.toast('error', 'Failed to process audio segment', String(err))
    })
    this.inflightSegments.add(p)
    void p.finally(() => this.inflightSegments.delete(p))
  }

  private async handleSegment(live: LiveMeeting, msg: AudioSegmentMessage): Promise<void> {
    const startMs = Math.max(0, msg.startedAt - live.record.startedAt)
    const outcome = await this.transcription.enqueue({
      id: newId('j'),
      source: msg.source,
      startMs,
      at: msg.startedAt,
      durationMs: msg.durationMs,
      wav: msg.wav,
      context: live.recentText(400)
    })
    if (live !== this.live) return
    if (outcome.error === 'merged' || outcome.error === 'cancelled') return
    const job = outcome.job
    const baseSpeaker = job.source === 'mic' ? 'You' : 'Remote'
    if (outcome.error || !outcome.result) {
      if (outcome.error === 'Transcription is turned off') return
      this.addSegment(live, {
        id: newId('s'),
        source: job.source,
        speaker: baseSpeaker,
        text: '',
        startMs: job.startMs,
        endMs: job.startMs + job.durationMs,
        at: job.at,
        status: 'failed',
        error: outcome.error
      })
      return
    }
    const parts = outcome.result.parts.length ? outcome.result.parts : [{ text: outcome.result.text }]
    const speakerMap = new Map<string, string>()
    for (const part of parts) {
      const text = cleanTranscriptText(part.text ?? '')
      // Part offsets are relative to the uploaded audio; merged jobs compress the gaps between
      // segments, so their offsets don't map back to meeting time — use the job span instead.
      const offsets = !job.merged
      const partStart = job.startMs + (offsets ? (part.startMs ?? 0) : 0)
      const partEnd = offsets && part.endMs !== undefined ? job.startMs + part.endMs : job.startMs + job.durationMs
      if (isLikelyHallucination(text, partEnd - partStart)) continue
      let speaker = baseSpeaker
      if (job.source === 'system' && part.speaker && parts.length > 1) {
        if (!speakerMap.has(part.speaker)) speakerMap.set(part.speaker, String.fromCharCode(65 + speakerMap.size))
        speaker = `Remote ${speakerMap.get(part.speaker)}`
      }
      const seg: TranscriptSegment = {
        id: newId('s'),
        source: job.source,
        speaker,
        text,
        startMs: partStart,
        endMs: partEnd,
        at: job.at + (partStart - job.startMs),
        status: 'ok'
      }
      if (seg.source === 'mic' && isEchoOfRemote(seg, live.record.segments.slice(-12))) continue
      this.addSegment(live, seg)
      if (seg.source === 'system') this.retractEchoes(live, seg)
    }
  }

  /**
   * Mic transcripts of short echoes often finish before the remote original (transcription runs
   * in parallel), so also check recent mic lines when a remote line arrives and retract echoes.
   */
  private retractEchoes(live: LiveMeeting, remote: TranscriptSegment): void {
    for (const mic of live.record.segments.slice(-12)) {
      if (mic.source !== 'mic' || mic.status !== 'ok') continue
      if (!isEchoOfRemote(mic, [remote])) continue
      const removed = live.removeSegment(mic.id)
      if (!removed) continue
      removed.status = 'removed'
      this.deps.broadcaster.send('segment', removed)
      if (live.persist) void this.deps.store.appendSegment(live.id, removed).catch(() => undefined)
    }
  }

  private addSegment(live: LiveMeeting, seg: TranscriptSegment): void {
    const update = live.addSegment(seg)
    this.deps.broadcaster.send('segment', seg)
    if (live.persist) void this.deps.store.appendSegment(live.id, seg).catch(() => undefined)
    if (update.added || update.answeredIds.length) {
      this.deps.broadcaster.send('questions', live.questions.map((q) => ({ ...q })))
    }
    if (update.added) {
      // An answer is likely next (click or auto-answer): have a connection ready.
      this.deps.registry.warm(this.deps.settings().ai.provider)
      this.assistant.onQuestionDetected()
    }
    this.scheduleSave()
    void this.assistant.maybeCompact()
  }

  // ------------------------------------------------------------------ screen

  async listSources(): Promise<CaptureSource[]> {
    const list = await this.deps.screens.list()
    if (!this.selectedSource) {
      const primary = list.find((s) => s.kind === 'screen')
      if (primary) this.applySource(primary)
    } else {
      // Window titles change; refresh the selected entry.
      const fresh = list.find((s) => s.id === this.selectedSource!.id)
      if (fresh) this.selectedSource = fresh
    }
    return list
  }

  async selectSource(sourceId: string | null): Promise<void> {
    if (!sourceId) {
      this.selectedSource = null
      this.patchStatus({
        screen: { ...this.status.screen, sourceId: undefined, sourceName: undefined, sourceKind: undefined, region: undefined, active: false }
      })
      this.clearAutoCapture()
      this.updateWatcher()
      return
    }
    const list = await this.deps.screens.list()
    const src = list.find((s) => s.id === sourceId)
    if (!src) throw new Error('That screen or window is no longer available.')
    this.applySource(src)
    this.scheduleAutoCapture()
    this.updateWatcher()
  }

  private applySource(src: CaptureSource): void {
    const changed = this.selectedSource?.id !== src.id
    this.selectedSource = src
    this.lastSignature = undefined
    if (changed) this.screenWatcher.reset()
    this.patchStatus({
      screen: {
        ...this.status.screen,
        sourceId: src.id,
        sourceName: src.name,
        sourceKind: src.kind,
        region: changed ? undefined : this.status.screen.region,
        active: true,
        error: undefined
      }
    })
  }

  async selectRegion(): Promise<Rect | null> {
    let src = this.selectedSource
    if (!src || src.kind !== 'screen') {
      const screens = (await this.deps.screens.list()).filter((s) => s.kind === 'screen')
      src = screens[0] ?? null
      if (!src) throw new Error('No screen available for region capture.')
      this.applySource(src)
    }
    const bounds = this.deps.screens.displayBounds(src)
    const rect = await this.deps.screens.pickRegion(src.displayId)
    if (!rect || !bounds) return null
    const region = toFractions(rect, bounds)
    if (region.width < 0.01 || region.height < 0.01) return null
    this.lastSignature = undefined
    this.screenWatcher.reset()
    this.patchStatus({ screen: { ...this.status.screen, region } })
    return region
  }

  clearRegion(): void {
    this.lastSignature = undefined
    this.screenWatcher.reset()
    this.patchStatus({ screen: { ...this.status.screen, region: undefined } })
  }

  setAutoCapture(enabled: boolean, intervalSec?: number): void {
    this.patchStatus({ screen: { ...this.status.screen, auto: enabled, intervalSec: intervalSec ?? this.status.screen.intervalSec } })
    this.scheduleAutoCapture()
  }

  private scheduleAutoCapture(): void {
    this.clearAutoCapture()
    const st = this.status.screen
    if (this.status.session !== 'running' || !st.auto || !this.selectedSource || this.screenWatcher?.active) return
    this.autoTimer = setInterval(() => void this.captureScreen('auto'), Math.max(3, st.intervalSec) * 1000)
  }

  private clearAutoCapture(): void {
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.autoTimer = null
  }

  captureScreen(trigger: 'manual' | 'auto' = 'manual'): Promise<ScreenSnapshot | null> {
    if (this.capturing) return this.capturing
    this.capturing = this.doCapture(trigger).finally(() => {
      this.capturing = null
      this.patchStatus({ screen: { ...this.status.screen, busy: false } })
    })
    return this.capturing
  }

  private async doCapture(trigger: 'manual' | 'auto'): Promise<ScreenSnapshot | null> {
    if (!this.selectedSource) await this.listSources().catch(() => [])
    const src = this.selectedSource
    if (!src) {
      if (trigger === 'manual') this.toast('warning', 'Select a screen or window to capture first.')
      return null
    }
    const live = this.live
    const s = this.deps.settings()
    this.patchStatus({ screen: { ...this.status.screen, busy: true } })

    const res = await this.deps.capture.grab(this.grabTarget(src), 20_000)
    if (!res.ok) {
      const error = res.error ?? 'Screen capture failed.'
      const previous = this.status.screen.error
      this.patchStatus({ screen: { ...this.status.screen, error, active: false } })
      // Auto-capture repeats every few seconds: toast only when the error is new.
      if (trigger === 'manual' || previous !== error) this.toast('error', error)
      return null
    }
    this.patchStatus({ screen: { ...this.status.screen, error: undefined, active: true, lastCaptureAt: Date.now() } })

    const prev = live.latestSnapshot()
    if (
      trigger === 'auto' &&
      s.screen.skipUnchanged &&
      prev &&
      prev.sourceId === src.id &&
      !isScreenChanged(this.lastSignature, res.signature)
    ) {
      prev.at = Date.now() // still what is on screen
      return prev
    }
    this.lastSignature = res.signature

    const snap: ScreenSnapshot = {
      id: newId('scr'),
      at: Date.now(),
      trigger,
      sourceId: src.id,
      sourceName: src.name,
      sourceKind: src.kind,
      region: this.status.screen.region,
      width: res.width ?? 0,
      height: res.height ?? 0,
      ocrText: '',
      ocrConfidence: 0,
      quality: 'pending',
      thumbnail: res.thumbnail
    }
    if (res.visionJpeg) {
      const dir = this.screenshotDir(live)
      await fs.mkdir(dir, { recursive: true })
      snap.imagePath = path.join(dir, `${snap.id}.jpg`)
      await fs.writeFile(snap.imagePath, res.visionJpeg)
    }
    const evicted = live.addSnapshot(snap)
    for (const old of evicted) if (old.imagePath && !this.keepsScreenshots(live)) void fs.rm(old.imagePath, { force: true })
    this.deps.broadcaster.send('snapshot', { ...snap })

    if (s.screen.ocrEnabled && res.ocrPng) {
      try {
        const ocr = await this.deps.ocr.recognize(res.ocrPng)
        snap.ocrText = ocr.text
        snap.ocrConfidence = ocr.confidence
        const q = assessScreenQuality({
          text: ocr.text,
          confidence: ocr.confidence,
          confidentShare: ocr.confidentShare,
          blankness: res.blankness
        })
        snap.quality = q.quality
        snap.qualityNote = q.note
      } catch (err) {
        snap.quality = 'unreadable'
        snap.qualityNote = `Text recognition failed: ${(err as Error).message}`
      }
    } else {
      snap.quality = (res.blankness ?? 0) > 0.985 ? 'unreadable' : 'partial'
      snap.qualityNote = 'Text recognition (OCR) is turned off — only vision models can read this capture.'
    }
    this.deps.broadcaster.send('snapshot', { ...snap })
    this.scheduleSave()
    return snap
  }

  /** What to grab: the selected source and region, with MyCluely's own windows blacked out. */
  private grabTarget(src: CaptureSource): Omit<GrabRequest, 'requestId'> {
    let masks: Rect[] = []
    if (src.kind === 'screen') {
      const bounds = this.deps.screens.displayBounds(src)
      if (bounds) {
        masks = this.deps.screens
          .ownWindowRects()
          .map((r) => intersect(r, bounds))
          .filter((r): r is Rect => !!r)
          .map((r) => toFractions(r, bounds))
      }
    }
    return { sourceId: src.id, sourceKind: src.kind, region: this.status.screen.region, masks }
  }

  private keepsScreenshots(live: LiveMeeting): boolean {
    return live.persist && this.deps.settings().privacy.keepScreenshots
  }

  private screenshotDir(live: LiveMeeting): string {
    return this.keepsScreenshots(live) ? this.deps.store.screensDir(live.id) : path.join(this.deps.cacheDir, live.id)
  }

  private async discardScreenshots(live: LiveMeeting): Promise<void> {
    await fs.rm(path.join(this.deps.cacheDir, live.id), { recursive: true, force: true }).catch(() => undefined)
    for (const s of live.record.snapshots) s.imagePath = undefined
  }

  // ------------------------------------------------------------------ assistant

  async runAction(req: RunActionRequest): Promise<string> {
    if (req.action === 'answer' && !req.questionId) {
      const now = Date.now()
      const spoken = this.live.tracker.latestOpen(now)
      if (!spoken || now - spoken.at > SPOKEN_QUESTION_MS) {
        // No question was just asked aloud: answer what needs answering in the conversation or
        // on screen, with a fresh look at the screen (cheap when it has not changed).
        if (this.selectedSource) await this.captureScreen('auto')
        return this.assistant.run({ ...req, screenFocus: true })
      }
    }
    if ((req.action === 'explain-screen' || req.action === 'screen-answer') && (this.selectedSource || (await this.listSources()).length)) {
      await this.captureScreen('manual')
    }
    return this.assistant.run(req)
  }

  dismissQuestion(id: string): void {
    this.live.tracker.dismiss(id)
    this.deps.broadcaster.send('questions', this.live.questions.map((q) => ({ ...q })))
    this.scheduleSave()
  }

  // ------------------------------------------------------------------ persistence

  private scheduleSave(): void {
    if (!this.live.persist || !this.live.started) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  async saveNow(live: LiveMeeting = this.live): Promise<void> {
    if (live === this.live) {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!live.persist || !live.started) return
    const now = Date.now()
    live.record.durationMs = (live.record.endedAt ?? now) - live.record.startedAt
    try {
      await this.deps.store.save(live.record)
    } catch (err) {
      this.toast('error', 'Could not save meeting history', String(err))
    }
  }

  /** Flush state on app quit. */
  async shutdown(): Promise<void> {
    this.clearAutoCapture()
    this.assistant.stopAuto()
    this.screenWatcher.stop()
    this.assistant.cancelAll()
    if (this.status.session === 'running' || this.status.session === 'paused') {
      this.deps.capture.command({ type: 'stop' })
      this.live.record.endedAt = Date.now()
      if (!this.keepsScreenshots(this.live)) await this.discardScreenshots(this.live)
    }
    await this.saveNow()
  }
}
