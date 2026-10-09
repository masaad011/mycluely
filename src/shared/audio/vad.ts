/**
 * Energy-based voice activity detector that turns a continuous 16 kHz mono stream into
 * utterance-sized segments for transcription. It adapts to the background noise floor, keeps
 * a short pre-roll so word onsets are not clipped, and splits long monologues at the quietest
 * recent frame so no segment exceeds `maxSegmentMs`.
 */
export interface VadOptions {
  sampleRate: number
  frameMs: number
  /** 0 = only loud speech counts, 1 = very sensitive. */
  sensitivity: number
  minSilenceMs: number
  maxSegmentMs: number
  minSpeechMs: number
  preRollMs: number
  postRollMs: number
}

export interface VadSegment {
  samples: Float32Array
  /** Index of the first sample relative to the start of the stream. */
  startSample: number
  endSample: number
  speechMs: number
  /** Peak frame RMS in dBFS. */
  peakDb: number
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  sampleRate: 16000,
  frameMs: 30,
  sensitivity: 0.6,
  minSilenceMs: 700,
  maxSegmentMs: 14000,
  minSpeechMs: 300,
  preRollMs: 300,
  postRollMs: 250
}

interface Frame {
  data: Float32Array
  db: number
  speech: boolean
  start: number
}

export class VadSegmenter {
  readonly opts: VadOptions
  private readonly frameLen: number
  private pending: Float32Array = new Float32Array(0)
  private consumed = 0
  private noiseDb = -60
  private preRoll: Frame[] = []
  private current: Frame[] = []
  private inSpeech = false
  private onsetCount = 0
  private silenceMs = 0
  private speechMs = 0
  private smoothedLevel = 0
  /** Frame levels of the last ~3 s, to detect steady noise mistaken for speech. */
  private recentDb: number[] = []

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...opts }
    this.frameLen = Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000)
  }

  /** True while an utterance is in progress. */
  get speaking(): boolean {
    return this.inSpeech
  }

  /** Smoothed input level 0..1 for meters. */
  get level(): number {
    return this.smoothedLevel
  }

  get noiseFloorDb(): number {
    return this.noiseDb
  }

  setSensitivity(sensitivity: number): void {
    this.opts.sensitivity = Math.min(1, Math.max(0, sensitivity))
  }

  push(samples: Float32Array): VadSegment[] {
    const out: VadSegment[] = []
    let buf: Float32Array
    if (this.pending.length) {
      buf = new Float32Array(this.pending.length + samples.length)
      buf.set(this.pending)
      buf.set(samples, this.pending.length)
    } else {
      buf = samples
    }
    let off = 0
    while (off + this.frameLen <= buf.length) {
      const data = buf.slice(off, off + this.frameLen)
      const seg = this.processFrame(data, this.consumed)
      if (seg) out.push(seg)
      this.consumed += this.frameLen
      off += this.frameLen
    }
    this.pending = buf.slice(off)
    return out
  }

  /** Emit whatever is buffered (e.g. on pause/stop). */
  flush(): VadSegment | null {
    const seg = this.inSpeech ? this.finish(this.current.length) : null
    this.reset()
    return seg
  }

  reset(): void {
    this.current = []
    this.preRoll = []
    this.inSpeech = false
    this.onsetCount = 0
    this.silenceMs = 0
    this.speechMs = 0
  }

  private thresholds(): { absDb: number; marginDb: number } {
    const s = this.opts.sensitivity
    return { absDb: -32 - 22 * s, marginDb: 16 - 10 * s }
  }

  private processFrame(data: Float32Array, start: number): VadSegment | null {
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const db = 20 * Math.log10(rms + 1e-9)
    const { absDb, marginDb } = this.thresholds()
    const speech = db > Math.max(absDb, this.noiseDb + marginDb)

    // Meter: map -70..-10 dBFS to 0..1 with fast attack / slow release.
    const lvl = Math.min(1, Math.max(0, (db + 70) / 60))
    this.smoothedLevel = lvl > this.smoothedLevel ? lvl : this.smoothedLevel * 0.85 + lvl * 0.15

    // Track the noise floor only from non-speech frames; follow drops quickly, rises slowly.
    if (!speech) {
      const a = db < this.noiseDb ? 0.3 : 0.03
      this.noiseDb = Math.min(-25, Math.max(-90, this.noiseDb * (1 - a) + db * a))
    }
    // Real speech has dips between words. If even the quietest frame of the last ~3 s is well
    // above the floor, it is steady noise (fan, hum, auto-gain): let the floor creep up to it so
    // the detector cannot stay "speaking" forever.
    this.recentDb.push(db)
    if (this.recentDb.length > Math.round(3000 / this.opts.frameMs)) this.recentDb.shift()
    if (speech && this.recentDb.length * this.opts.frameMs >= 3000) {
      let quietest = Infinity
      for (const v of this.recentDb) if (v < quietest) quietest = v
      if (quietest > this.noiseDb + 6) this.noiseDb = Math.min(-25, this.noiseDb + (quietest - this.noiseDb) * 0.02)
    }

    const frame: Frame = { data, db, speech, start }
    const fm = this.opts.frameMs

    if (!this.inSpeech) {
      this.preRoll.push(frame)
      const maxPre = Math.ceil(this.opts.preRollMs / fm) + 2
      if (this.preRoll.length > maxPre) this.preRoll.shift()
      this.onsetCount = speech ? this.onsetCount + 1 : 0
      if (this.onsetCount >= 2) {
        this.inSpeech = true
        this.current = this.preRoll.slice()
        this.preRoll = []
        this.speechMs = this.onsetCount * fm
        this.silenceMs = 0
      }
      return null
    }

    this.current.push(frame)
    if (speech) {
      this.speechMs += fm
      this.silenceMs = 0
    } else {
      this.silenceMs += fm
    }

    if (this.silenceMs >= this.opts.minSilenceMs) {
      const keepTrailing = Math.ceil(this.opts.postRollMs / fm)
      const silentFrames = Math.round(this.silenceMs / fm)
      const end = Math.max(1, this.current.length - silentFrames + keepTrailing)
      const seg = this.finish(end)
      this.reset()
      return seg
    }

    if (this.current.length * fm >= this.opts.maxSegmentMs) {
      // Split at the quietest frame in the last ~1.5 s so we don't cut mid-word.
      const window = Math.min(this.current.length - 1, Math.ceil(1500 / fm))
      let cut = this.current.length
      let minDb = Infinity
      for (let i = this.current.length - window; i < this.current.length; i++) {
        if (this.current[i].db < minDb) {
          minDb = this.current[i].db
          cut = i + 1
        }
      }
      const rest = this.current.slice(cut)
      const seg = this.finish(cut)
      this.current = rest
      this.speechMs = rest.filter((f) => f.speech).length * fm
      this.silenceMs = 0
      return seg
    }
    return null
  }

  private finish(endFrame: number): VadSegment | null {
    const frames = this.current.slice(0, endFrame)
    if (!frames.length) return null
    const speechMs = frames.filter((f) => f.speech).length * this.opts.frameMs
    if (speechMs < this.opts.minSpeechMs) return null
    const samples = new Float32Array(frames.length * this.frameLen)
    frames.forEach((f, i) => samples.set(f.data, i * this.frameLen))
    const peakDb = frames.reduce((m, f) => Math.max(m, f.db), -Infinity)
    return {
      samples,
      startSample: frames[0].start,
      endSample: frames[frames.length - 1].start + this.frameLen,
      speechMs,
      peakDb
    }
  }
}
