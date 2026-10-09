/** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  writeAscii(v, 0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  writeAscii(v, 8, 'WAVE')
  writeAscii(v, 12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeAscii(v, 36, 'data')
  v.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Uint8Array(buf)
}

export interface DecodedWav {
  sampleRate: number
  channels: number
  /** Mono mix of all channels. */
  samples: Float32Array
}

/** Decode a PCM (8/16/24/32-bit int) or IEEE float WAV into mono float samples. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readAscii(v, 0, 4) !== 'RIFF' || readAscii(v, 8, 4) !== 'WAVE') throw new Error('Not a WAV file')
  let off = 12
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  while (off + 8 <= v.byteLength) {
    const id = readAscii(v, off, 4)
    const size = v.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      let format = v.getUint16(body, true)
      const channels = v.getUint16(body + 2, true)
      const sampleRate = v.getUint32(body + 4, true)
      const bits = v.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, bits }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk')
      const dataLen = Math.min(size, v.byteLength - body)
      const bytesPer = fmt.bits / 8
      const frames = Math.floor(dataLen / (bytesPer * fmt.channels))
      const out = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let acc = 0
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (f * fmt.channels + c) * bytesPer
          acc += readSample(v, p, fmt.format, fmt.bits)
        }
        out[f] = acc / fmt.channels
      }
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples: out }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV file has no data chunk')
}

function readSample(v: DataView, p: number, format: number, bits: number): number {
  if (format === 3) return bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true)
  switch (bits) {
    case 8:
      return (v.getUint8(p) - 128) / 128
    case 16:
      return v.getInt16(p, true) / 32768
    case 24: {
      const b = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)
      return b / 8388608
    }
    case 32:
      return v.getInt32(p, true) / 2147483648
    default:
      throw new Error(`Unsupported WAV bit depth ${bits}`)
  }
}

function writeAscii(v: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
}

function readAscii(v: DataView, off: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i))
  return s
}

/** Duration in ms of a 16-bit mono WAV produced by encodeWav. */
export function wavDurationMs(bytes: Uint8Array, sampleRate = 16000): number {
  return ((bytes.byteLength - 44) / 2 / sampleRate) * 1000
}

/** Concatenate WAVs produced by encodeWav (same rate) with a short silence gap. */
export function concatWavs(parts: Uint8Array[], sampleRate = 16000, gapMs = 250): Uint8Array {
  const decoded = parts.map((p) => decodeWav(p).samples)
  const gap = Math.round((gapMs / 1000) * sampleRate)
  const total = decoded.reduce((n, s) => n + s.length, 0) + gap * Math.max(0, decoded.length - 1)
  const out = new Float32Array(total)
  let off = 0
  decoded.forEach((s, i) => {
    out.set(s, off)
    off += s.length + (i < decoded.length - 1 ? gap : 0)
  })
  return encodeWav(out, sampleRate)
}
