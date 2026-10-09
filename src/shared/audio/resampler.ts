/**
 * Streaming mono resampler: windowed-sinc low-pass (when downsampling) followed by linear
 * interpolation. Good enough for speech recognition and cheap enough to run per 100 ms chunk.
 */
export class Resampler {
  private readonly ratio: number
  private readonly taps: Float32Array | null
  private history: Float32Array
  private pos = 0
  private prev = 0

  constructor(
    readonly inRate: number,
    readonly outRate: number
  ) {
    if (inRate <= 0 || outRate <= 0) throw new Error('Invalid sample rate')
    this.ratio = inRate / outRate
    this.taps = this.ratio > 1 ? designLowPass(0.5 / this.ratio, 33) : null
    this.history = new Float32Array(this.taps ? this.taps.length - 1 : 0)
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice()
    const filtered = this.taps ? this.filter(input) : input
    const out: number[] = []
    let pos = this.pos
    const n = filtered.length
    while (Math.floor(pos) + 1 < n) {
      const i = Math.floor(pos)
      const frac = pos - i
      const s0 = i < 0 ? this.prev : filtered[i]
      const s1 = filtered[i + 1]
      out.push(s0 + (s1 - s0) * frac)
      pos += this.ratio
    }
    this.pos = pos - n
    if (n > 0) this.prev = filtered[n - 1]
    return Float32Array.from(out)
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps as Float32Array
    const hl = this.history.length
    const buf = new Float32Array(hl + input.length)
    buf.set(this.history, 0)
    buf.set(input, hl)
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) {
      let acc = 0
      for (let k = 0; k < taps.length; k++) acc += buf[i + k] * taps[k]
      out[i] = acc
    }
    this.history = buf.slice(buf.length - hl)
    return out
  }
}

/** Hann-windowed sinc low-pass. `cutoff` is normalised to the input sample rate (0..0.5). */
export function designLowPass(cutoff: number, numTaps: number): Float32Array {
  const taps = new Float32Array(numTaps)
  const m = numTaps - 1
  let sum = 0
  for (let i = 0; i < numTaps; i++) {
    const x = i - m / 2
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / m)
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < numTaps; i++) taps[i] /= sum
  return taps
}

/** Mix an interleaved or planar multi-channel block down to mono. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0].slice()
  const len = channels[0].length
  const out = new Float32Array(len)
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i]
  const inv = 1 / channels.length
  for (let i = 0; i < len; i++) out[i] *= inv
  return out
}
