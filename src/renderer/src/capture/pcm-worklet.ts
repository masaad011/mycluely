// AudioWorklet: mixes the input to mono and posts ~100 ms Float32 blocks to the main thread.
// Runs on the real-time audio thread, so it does no allocation beyond the block buffers.

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

class PcmCapture extends AudioWorkletProcessor {
  // Fixed block size: after a transfer the old array is detached (length 0), so never derive
  // the next buffer's size from it.
  private readonly size = Math.round(sampleRate * 0.1)
  private buf = new Float32Array(this.size)
  private n = 0

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    const channels = input.length
    const len = input[0].length
    for (let i = 0; i < len; i++) {
      let v = 0
      for (let c = 0; c < channels; c++) v += input[c][i]
      this.buf[this.n++] = v / channels
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(this.size)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
