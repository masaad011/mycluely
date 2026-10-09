import { createWorker, OEM, type Worker } from 'tesseract.js'
import { cleanOcrWords, type OcrWord } from '@shared/screen'
import { SerialQueue } from '../services/json-file'

export interface OcrResult {
  text: string
  /** Length-weighted mean confidence of the kept words (0..100). */
  confidence: number
  /** Share of text read with high confidence (0..1); drives the readability rating. */
  confidentShare: number
  durationMs: number
}

interface TesseractBlock {
  paragraphs?: { lines?: { words?: OcrWord[] }[] }[]
}

export interface OcrOptions {
  /** Folder that contains `eng.traineddata.gz`. */
  langPath: string
  /** Writable folder for the unpacked language cache. */
  cachePath: string
  lang?: string
  timeoutMs?: number
}

/**
 * Local OCR with tesseract.js (WASM, runs in a Node worker thread — never blocks the UI).
 * The English model ships with the app, so OCR works offline and without credentials.
 */
export class OcrService {
  private worker: Promise<Worker> | null = null
  private readonly queue = new SerialQueue()

  constructor(private readonly opts: OcrOptions) {}

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      this.worker = createWorker(this.opts.lang ?? 'eng', OEM.LSTM_ONLY, {
        langPath: this.opts.langPath,
        cachePath: this.opts.cachePath,
        gzip: true
      }).then(async (w) => {
        // Screens mix paragraphs, UI labels and code: automatic page segmentation works best.
        await w.setParameters({ preserve_interword_spaces: '1' })
        return w
      })
      this.worker.catch(() => {
        this.worker = null
      })
    }
    return this.worker
  }

  recognize(image: Uint8Array): Promise<OcrResult> {
    return this.queue.run(async () => {
      const started = Date.now()
      const worker = await this.getWorker()
      const timeout = this.opts.timeoutMs ?? 45_000
      let timer: NodeJS.Timeout | undefined
      try {
        const result = await Promise.race([
          worker.recognize(Buffer.from(image), {}, { text: true, blocks: true }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('OCR timed out')), timeout)
          })
        ])
        // Word-level output lets us drop junk read from icons/toolbars and score fairly.
        const lines = ((result.data.blocks ?? []) as TesseractBlock[]).flatMap((b) =>
          (b.paragraphs ?? []).flatMap((p) => (p.lines ?? []).map((l) => ({ words: l.words ?? [] })))
        )
        if (!lines.length) {
          const confidence = result.data.confidence ?? 0
          return { text: normalizeOcrText(result.data.text ?? ''), confidence, confidentShare: confidence / 100, durationMs: Date.now() - started }
        }
        const clean = cleanOcrWords(lines)
        return { text: clean.text, confidence: clean.confidence, confidentShare: clean.confidentShare, durationMs: Date.now() - started }
      } catch (err) {
        // A wedged worker is replaced on the next call.
        await this.terminate()
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
  }

  async terminate(): Promise<void> {
    const w = this.worker
    this.worker = null
    if (w) await w.then((x) => x.terminate()).catch(() => undefined)
  }
}

export function normalizeOcrText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
