import type { LocalSttProgress, LocalSttRequest } from '@shared/ipc'
import { decodeWav } from '@shared/audio/wav'
import { Resampler } from '@shared/audio/resampler'
import WhisperWorker from './whisper.worker.ts?worker'

/** Runs on-device Whisper in a dedicated worker so inference never blocks capture. */
export class LocalStt {
  private worker: Worker | null = null
  private pending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>()

  constructor(private readonly onProgress: (p: LocalSttProgress) => void) {}

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new WhisperWorker()
    w.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m?.type === 'progress') {
        this.onProgress({ status: m.status, progress: m.progress, device: m.device, message: m.message })
      } else if (m?.type === 'result') {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error))
        else p.resolve(m.text ?? '')
      }
    }
    w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Whisper worker crashed'))
      this.pending.clear()
      this.worker?.terminate()
      this.worker = null
    }
    this.worker = w
    return w
  }

  transcribe(req: LocalSttRequest): Promise<string> {
    const decoded = decodeWav(req.wav)
    let audio = decoded.samples
    if (decoded.sampleRate !== 16000) audio = new Resampler(decoded.sampleRate, 16000).process(audio)
    const w = this.ensure()
    return new Promise((resolve, reject) => {
      this.pending.set(req.requestId, { resolve, reject })
      w.postMessage(
        {
          type: 'transcribe',
          id: req.requestId,
          model: req.model,
          language: req.language,
          audio
        },
        [audio.buffer]
      )
    })
  }
}
