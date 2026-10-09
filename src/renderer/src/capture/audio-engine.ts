import type { AudioCaptureConfig, AudioSegmentMessage, CaptureCommand, ChannelStatusMessage } from '@shared/ipc'
import type { AudioDevice, AudioLevels, AudioSourceKind } from '@shared/types'
import { Resampler } from '@shared/audio/resampler'
import { VadSegmenter, type VadSegment } from '@shared/audio/vad'
import { encodeWav } from '@shared/audio/wav'
import workletUrl from './pcm-worklet.ts?worker&url'

const TARGET_RATE = 16000
const MAX_RESTARTS = 3

export interface AudioEngineEvents {
  segment(m: AudioSegmentMessage): void
  levels(l: AudioLevels): void
  channel(m: ChannelStatusMessage): void
  devices(d: AudioDevice[]): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

interface Pipeline {
  kind: AudioSourceKind
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  resampler: Resampler
  vad: VadSegmenter
  /** Epoch ms of sample 0 of the current VAD timeline. */
  epochStart?: number
  label: string
  deviceId?: string
  stopping: boolean
}

/**
 * Captures the microphone and Windows system audio (loopback) as two independent pipelines:
 * MediaStream → AudioWorklet (mono) → resample to 16 kHz → VAD → WAV segments → main process.
 * The channel a segment came from is what labels it "You" or "Remote".
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private sink: GainNode | null = null
  private pipelines: Partial<Record<AudioSourceKind, Pipeline>> = {}
  private config: AudioCaptureConfig | null = null
  private running = false
  private paused = false
  private restarts: Record<AudioSourceKind, number> = { mic: 0, system: 0 }
  private levelTimer: number | null = null
  private devices: AudioDevice[] = []
  /** Commands run strictly one after another (a Stop must never interleave with a Start). */
  private commands: Promise<void> = Promise.resolve()
  /** Bumped by start/stop; async work started under an older generation is discarded. */
  private generation = 0

  constructor(private readonly ev: AudioEngineEvents) {
    navigator.mediaDevices.addEventListener('devicechange', () => void this.onDeviceChange())
  }

  handle(cmd: CaptureCommand): Promise<void> {
    return this.enqueue(() => this.exec(cmd), cmd.type)
  }

  private enqueue(fn: () => Promise<void> | void, label: string): Promise<void> {
    const run = this.commands.then(fn).catch((err) => {
      this.ev.log('error', `capture command ${label} failed: ${String(err)}`)
    })
    this.commands = run
    return run
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation && this.running && !!this.ctx
  }

  private async exec(cmd: CaptureCommand): Promise<void> {
    switch (cmd.type) {
      case 'start':
        return this.start(cmd.audio)
      case 'configure':
        return this.configure(cmd.audio)
      case 'pause':
        return this.setPaused(true)
      case 'resume':
        return this.setPaused(false)
      case 'stop':
        return this.stop()
      case 'refresh-devices':
        await this.refreshDevices()
    }
  }

  private async ensureContext(): Promise<AudioContext> {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return this.ctx
    }
    const ctx = new AudioContext({ latencyHint: 'playback' })
    await ctx.audioWorklet.addModule(workletUrl)
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.sink.connect(ctx.destination)
    this.ctx = ctx
    return ctx
  }

  async start(config: AudioCaptureConfig): Promise<void> {
    await this.stop()
    const gen = this.generation
    this.config = config
    this.running = true
    this.paused = false
    this.restarts = { mic: 0, system: 0 }
    await this.ensureContext()
    await Promise.all([
      config.micEnabled ? this.startMic(gen) : this.reportDisabled('mic'),
      config.systemEnabled ? this.startSystem(gen) : this.reportDisabled('system')
    ])
    this.startLevels()
  }

  private reportDisabled(kind: AudioSourceKind): void {
    this.ev.channel({ channel: kind, active: false, label: 'Off' })
  }

  async configure(config: AudioCaptureConfig): Promise<void> {
    const prev = this.config
    this.config = config
    if (!this.running || !prev) return
    // VAD parameters apply to new segments immediately.
    for (const p of Object.values(this.pipelines)) {
      if (!p) continue
      if (prev.vadSensitivity !== config.vadSensitivity) p.vad.setSensitivity(config.vadSensitivity)
      if (prev.minSilenceMs !== config.minSilenceMs || prev.maxSegmentSec !== config.maxSegmentSec) {
        this.flush(p)
        p.vad = this.newVad()
        p.epochStart = undefined
      }
    }
    if (prev.micEnabled !== config.micEnabled || prev.micDeviceId !== config.micDeviceId) {
      this.stopPipeline('mic')
      if (config.micEnabled) await this.startMic(this.generation)
      else this.reportDisabled('mic')
    }
    if (prev.systemEnabled !== config.systemEnabled) {
      this.stopPipeline('system')
      if (config.systemEnabled) await this.startSystem(this.generation)
      else this.reportDisabled('system')
    }
  }

  private newVad(): VadSegmenter {
    const c = this.config!
    return new VadSegmenter({
      sampleRate: TARGET_RATE,
      sensitivity: c.vadSensitivity,
      minSilenceMs: c.minSilenceMs,
      maxSegmentMs: c.maxSegmentSec * 1000
    })
  }

  private async startMic(gen: number): Promise<void> {
    const c = this.config!
    const wanted = c.micDeviceId && c.micDeviceId !== 'default' ? c.micDeviceId : undefined
    const constraints = (deviceId?: string): MediaStreamConstraints => ({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
    let stream: MediaStream
    let note: string | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(wanted))
    } catch (err) {
      if (!wanted) return this.channelError('mic', `Microphone unavailable: ${describeMediaError(err)}`)
      note = 'Selected microphone not found — using the default microphone.'
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints())
      } catch (err2) {
        return this.channelError('mic', `Microphone unavailable: ${describeMediaError(err2)}`)
      }
    }
    if (!this.isCurrent(gen)) return stopStream(stream) // stopped or restarted meanwhile
    const track = stream.getAudioTracks()[0]
    const label = track?.label || 'Microphone'
    this.attach('mic', stream, label, track?.getSettings().deviceId)
    this.ev.channel({ channel: 'mic', active: true, label, error: note })
    await this.refreshDevices()
  }

  private async startSystem(gen: number): Promise<void> {
    let stream: MediaStream
    try {
      // Electron's display-media handler grants Windows loopback audio. A (tiny) video track is
      // mandatory for getDisplayMedia; it is stopped right away.
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: { width: { ideal: 16 }, height: { ideal: 16 }, frameRate: { ideal: 1 } }
      } as DisplayMediaStreamOptions)
    } catch (err) {
      return this.channelError('system', `System audio unavailable: ${describeMediaError(err)}`)
    }
    for (const t of stream.getVideoTracks()) {
      t.stop()
      stream.removeTrack(t)
    }
    if (!this.isCurrent(gen)) return stopStream(stream) // stopped or restarted meanwhile
    if (!stream.getAudioTracks().length) {
      return this.channelError('system', 'System audio is not supported on this system (no loopback track).')
    }
    this.attach('system', stream, 'System audio (all apps)')
    this.ev.channel({ channel: 'system', active: true, label: 'System audio (all apps)' })
  }

  private channelError(kind: AudioSourceKind, error: string): void {
    this.ev.log('warn', error)
    this.ev.channel({ channel: kind, active: false, error })
  }

  private attach(kind: AudioSourceKind, stream: MediaStream, label: string, deviceId?: string): void {
    // Never run two pipelines for the same channel.
    if (this.pipelines[kind]) this.stopPipeline(kind)
    const ctx = this.ctx!
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    source.connect(node)
    node.connect(this.sink!)
    const p: Pipeline = {
      kind,
      stream,
      source,
      node,
      resampler: new Resampler(ctx.sampleRate, TARGET_RATE),
      vad: this.newVad(),
      label,
      deviceId,
      stopping: false
    }
    let first = true
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (first) {
        first = false
        this.ev.log('info', `${kind}: receiving audio (${e.data.length} samples per block @ ${ctx.sampleRate} Hz)`)
      }
      this.onChunk(p, e.data)
    }
    this.ev.log('info', `${kind}: attached "${label}" (context ${ctx.sampleRate} Hz, state ${ctx.state})`)
    for (const t of stream.getAudioTracks()) {
      t.enabled = !this.paused
      t.addEventListener('ended', () => void this.onTrackEnded(p))
    }
    this.pipelines[kind] = p
  }

  private onChunk(p: Pipeline, chunk: Float32Array): void {
    if (this.paused || p.stopping) return
    const pcm = p.resampler.process(chunk)
    if (p.epochStart === undefined) p.epochStart = Date.now() - (pcm.length / TARGET_RATE) * 1000
    for (const seg of p.vad.push(pcm)) this.emit(p, seg)
  }

  private emit(p: Pipeline, seg: VadSegment): void {
    if (p.epochStart === undefined) return
    const wav = encodeWav(seg.samples, TARGET_RATE)
    this.ev.log('info', `${p.kind}: segment ${(seg.samples.length / TARGET_RATE).toFixed(1)}s (speech ${seg.speechMs} ms, peak ${seg.peakDb.toFixed(0)} dB)`)
    this.ev.segment({
      source: p.kind,
      startedAt: Math.round(p.epochStart + (seg.startSample / TARGET_RATE) * 1000),
      durationMs: Math.round((seg.samples.length / TARGET_RATE) * 1000),
      peakDb: seg.peakDb,
      wav
    })
  }

  private flush(p: Pipeline): void {
    const seg = p.vad.flush()
    if (seg) this.emit(p, seg)
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    for (const p of Object.values(this.pipelines)) {
      if (!p) continue
      if (paused) this.flush(p)
      // Muted tracks deliver silence, so nothing is processed while paused.
      for (const t of p.stream.getAudioTracks()) t.enabled = !paused
      p.vad = this.newVad()
      p.epochStart = undefined
    }
  }

  private async onTrackEnded(p: Pipeline): Promise<void> {
    if (p.stopping || !this.running || this.pipelines[p.kind] !== p) return
    const gen = this.generation
    this.flush(p)
    this.stopPipeline(p.kind, false)
    if (this.restarts[p.kind] >= MAX_RESTARTS) {
      return this.channelError(p.kind, `${p.kind === 'mic' ? 'Microphone' : 'System audio'} stopped and could not be restarted.`)
    }
    this.restarts[p.kind]++
    this.ev.channel({ channel: p.kind, active: false, error: `${p.label} disconnected — reconnecting…` })
    await new Promise((r) => setTimeout(r, 1000 * this.restarts[p.kind]))
    // Reconnect through the command queue, and only if nothing restarted or stopped capture meanwhile.
    await this.enqueue(async () => {
      if (gen !== this.generation || !this.running || this.pipelines[p.kind]) return
      if (p.kind === 'mic' && this.config?.micEnabled) await this.startMic(gen)
      if (p.kind === 'system' && this.config?.systemEnabled) await this.startSystem(gen)
    }, `reconnect ${p.kind}`)
  }

  private stopPipeline(kind: AudioSourceKind, flush = true): void {
    const p = this.pipelines[kind]
    if (!p) return
    if (flush) this.flush(p)
    p.stopping = true
    p.node.port.onmessage = null
    try {
      p.source.disconnect()
      p.node.disconnect()
    } catch {
      /* already disconnected */
    }
    for (const t of p.stream.getTracks()) t.stop()
    delete this.pipelines[kind]
  }

  async stop(): Promise<void> {
    this.generation++
    this.running = false
    this.stopPipeline('mic')
    this.stopPipeline('system')
    if (this.levelTimer !== null) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.ev.levels({ mic: 0, system: 0, micSpeaking: false, systemSpeaking: false })
    if (this.ctx) {
      const ctx = this.ctx
      this.ctx = null
      await ctx.close().catch(() => undefined)
    }
  }

  private startLevels(): void {
    if (this.levelTimer !== null) clearInterval(this.levelTimer)
    this.levelTimer = window.setInterval(() => {
      const m = this.pipelines.mic
      const s = this.pipelines.system
      this.ev.levels({
        mic: m && !this.paused ? m.vad.level : 0,
        system: s && !this.paused ? s.vad.level : 0,
        micSpeaking: !!m && !this.paused && m.vad.speaking,
        systemSpeaking: !!s && !this.paused && s.vad.speaking
      })
    }, 120)
  }

  async refreshDevices(): Promise<AudioDevice[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      this.devices = all
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || (d.deviceId === 'default' ? 'Default microphone' : 'Microphone'),
          isDefault: d.deviceId === 'default'
        }))
      this.ev.devices(this.devices)
    } catch (err) {
      this.ev.log('warn', `enumerateDevices failed: ${String(err)}`)
    }
    return this.devices
  }

  private async onDeviceChange(): Promise<void> {
    const devices = await this.refreshDevices()
    const mic = this.pipelines.mic
    if (!mic || !this.running) return
    // If the device in use vanished, the track normally ends; handle drivers that don't end it.
    if (mic.deviceId && mic.deviceId !== 'default' && !devices.some((d) => d.deviceId === mic.deviceId)) {
      void this.onTrackEnded(mic)
    }
  }
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop()
}

function describeMediaError(err: unknown): string {
  const e = err as DOMException
  switch (e?.name) {
    case 'NotAllowedError':
      return 'permission denied'
    case 'NotFoundError':
      return 'no device found'
    case 'NotReadableError':
      return 'the device is in use or blocked by the OS (check Windows privacy settings)'
    case 'OverconstrainedError':
      return 'device not available'
    default:
      return e?.message || String(err)
  }
}
