import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Resampler, mixToMono } from '@shared/audio/resampler'
import { VadSegmenter } from '@shared/audio/vad'
import { concatWavs, decodeWav, encodeWav, wavDurationMs } from '@shared/audio/wav'

const RATE = 16000

/** Speech-like signal: 200 Hz carrier with syllable-rate amplitude modulation and a little noise. */
function speech(seconds: number, rate = RATE, amp = 0.3): Float32Array {
  const n = Math.round(seconds * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)
    out[i] = amp * env * (Math.sin(2 * Math.PI * 200 * t) + 0.5 * Math.sin(2 * Math.PI * 450 * t)) + (Math.random() - 0.5) * 0.004
  }
  return out
}

function silence(seconds: number, rate = RATE, noise = 0.002): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() - 0.5) * noise
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Feed in 100 ms blocks like the AudioWorklet does. */
function feed(vad: VadSegmenter, signal: Float32Array, block = 1600) {
  const segs = []
  for (let i = 0; i < signal.length; i += block) segs.push(...vad.push(signal.subarray(i, i + block)))
  return segs
}

describe('wav codec', () => {
  it('round-trips 16-bit PCM', () => {
    const s = speech(0.5)
    const wav = encodeWav(s, RATE)
    expect(wav.byteLength).toBe(44 + s.length * 2)
    const d = decodeWav(wav)
    expect(d.sampleRate).toBe(RATE)
    expect(d.samples.length).toBe(s.length)
    let maxErr = 0
    for (let i = 0; i < s.length; i++) maxErr = Math.max(maxErr, Math.abs(d.samples[i] - s[i]))
    expect(maxErr).toBeLessThan(1 / 16000)
    expect(wavDurationMs(wav)).toBeCloseTo(500, 0)
  })

  it('decodes the System.Speech fixture', () => {
    const d = decodeWav(readFileSync(path.join(__dirname, '../fixtures/question.wav')))
    expect(d.sampleRate).toBe(16000)
    expect(d.samples.length / d.sampleRate).toBeGreaterThan(2)
  })

  it('concatenates segments with a gap', () => {
    const a = encodeWav(speech(1), RATE)
    const b = encodeWav(speech(0.5), RATE)
    const c = decodeWav(concatWavs([a, b], RATE, 250))
    expect(c.samples.length).toBe(RATE * 1 + RATE * 0.5 + RATE * 0.25)
  })
})

describe('resampler', () => {
  it('downsamples 48 kHz to 16 kHz preserving frequency', () => {
    const r = new Resampler(48000, 16000)
    const n = 48000
    const sine = new Float32Array(n)
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / 48000)
    // Process in uneven chunks to exercise streaming state.
    const out: number[] = []
    for (let i = 0; i < n; i += 4801) out.push(...r.process(sine.subarray(i, i + 4801)))
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2)
    let crossings = 0
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++
    expect(crossings).toBeGreaterThanOrEqual(438)
    expect(crossings).toBeLessThanOrEqual(442)
  })

  it('attenuates content above the new Nyquist frequency', () => {
    const r = new Resampler(48000, 16000)
    const n = 48000
    const high = new Float32Array(n)
    for (let i = 0; i < n; i++) high[i] = Math.sin((2 * Math.PI * 15000 * i) / 48000)
    const out = r.process(high)
    const rms = Math.sqrt(out.slice(100).reduce((s, v) => s + v * v, 0) / (out.length - 100))
    expect(rms).toBeLessThan(0.1)
  })

  it('passes through when rates match and mixes channels', () => {
    const r = new Resampler(16000, 16000)
    const x = new Float32Array([0.1, 0.2, 0.3])
    expect(Array.from(r.process(x))).toEqual(Array.from(x))
    const mono = mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])
    expect(Array.from(mono)).toEqual([0.5, 0.5])
  })
})

describe('voice activity segmenter', () => {
  it('splits utterances separated by silence', () => {
    const vad = new VadSegmenter({ sampleRate: RATE, minSilenceMs: 600 })
    const signal = concat(silence(1), speech(2), silence(1.2), speech(1.5), silence(1.2))
    const segs = feed(vad, signal)
    expect(segs).toHaveLength(2)
    // First utterance starts ~1 s in (minus pre-roll) and lasts ~2 s (+ pre/post roll).
    expect(segs[0].startSample / RATE).toBeGreaterThan(0.6)
    expect(segs[0].startSample / RATE).toBeLessThan(1.05)
    expect(segs[0].samples.length / RATE).toBeGreaterThan(1.9)
    expect(segs[0].samples.length / RATE).toBeLessThan(3)
    expect(segs[1].startSample / RATE).toBeGreaterThan(3.8)
  })

  it('ignores low-level background noise', () => {
    const vad = new VadSegmenter({ sampleRate: RATE })
    expect(feed(vad, silence(5, RATE, 0.01))).toHaveLength(0)
    expect(vad.flush()).toBeNull()
  })

  it('does not stay "speaking" forever in steady background noise', () => {
    const vad = new VadSegmenter({ sampleRate: RATE })
    // Constant noise around -44 dBFS: above the initial absolute threshold.
    const noise = new Float32Array(RATE * 60)
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.0108
    const segs = feed(vad, noise)
    expect(segs.length).toBeLessThanOrEqual(2)
    expect(vad.speaking).toBe(false)
    // Speech on top of the same noise is still detected.
    const mixed = speech(2)
    for (let i = 0; i < mixed.length; i++) mixed[i] += (Math.random() * 2 - 1) * 0.0108
    const after = feed(vad, concat(mixed, noise.subarray(0, RATE * 2)))
    expect(after.length).toBe(1)
  })

  it('caps long monologues at maxSegmentMs', () => {
    const vad = new VadSegmenter({ sampleRate: RATE, maxSegmentMs: 5000 })
    const segs = feed(vad, concat(silence(0.5), speech(17), silence(1.5)))
    expect(segs.length).toBeGreaterThanOrEqual(3)
    for (const s of segs) expect(s.samples.length / RATE).toBeLessThanOrEqual(5.05)
    const total = segs.reduce((n, s) => n + s.samples.length, 0) / RATE
    expect(total).toBeGreaterThan(16)
  })

  it('flushes an in-progress utterance', () => {
    const vad = new VadSegmenter({ sampleRate: RATE })
    feed(vad, concat(silence(0.5), speech(1.5)))
    expect(vad.speaking).toBe(true)
    const seg = vad.flush()
    expect(seg).not.toBeNull()
    expect(seg!.samples.length / RATE).toBeGreaterThan(1.4)
    expect(vad.speaking).toBe(false)
  })

  it('detects real synthesized speech in the fixture', () => {
    const d = decodeWav(readFileSync(path.join(__dirname, '../fixtures/question.wav')))
    const vad = new VadSegmenter({ sampleRate: 16000, maxSegmentMs: 14000 })
    const segs = [...feed(vad, d.samples)]
    const tail = vad.flush()
    if (tail) segs.push(tail)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    const voiced = segs.reduce((n, s) => n + s.speechMs, 0)
    expect(voiced).toBeGreaterThan(1500)
  })
})
