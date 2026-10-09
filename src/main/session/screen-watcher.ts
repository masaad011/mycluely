import { isScreenChanged } from '@shared/screen'
import { hasNewContent, looksAnswerable, sameScreenText, screenWords } from '@shared/screen-text'
import type { ScreenSnapshot, ScreenWatchState } from '@shared/types'

export interface ScreenWatcherDeps {
  /** Cheap change check of the watched area: its change signature only (no images encoded). */
  probe(): Promise<{ ok: boolean; signature?: Uint8Array; error?: string }>
  /** Full capture + OCR of the watched area; null when the capture failed. */
  capture(): Promise<ScreenSnapshot | null>
  /** Answer what is on this capture. `nothing`: the model found nothing that needs an answer. */
  answer(snap: ScreenSnapshot): Promise<'answered' | 'nothing' | 'failed'>
  /** Whether the selected model will receive the screenshot itself (not just OCR text). */
  seesImages(): boolean
  /** An answer is being written; automatic answers never overlap. */
  busy(): boolean
  /** Minimum time between automatic answers. */
  cooldownMs(): number
  setState(state: ScreenWatchState, detail?: string): void
}

export interface ScreenWatcherTimings {
  /** How often the screen is checked for changes. */
  probeMs: number
  /** How long the screen must stay unchanged before it is read. */
  settleMs: number
  /** When the screen never stops changing (e.g. video in a call), read its text this often and answer once the text is stable. */
  rereadMs: number
}

const DEFAULT_TIMINGS: ScreenWatcherTimings = { probeMs: 1200, settleMs: 1000, rereadMs: 3000 }
/** Content already answered (or judged to need no answer) that is never answered again. */
const MAX_HANDLED = 30

/**
 * Auto answer mode for the screen. While active it checks the selected screen, window or region
 * for changes; once a change has settled it captures and reads the screen and, if something new
 * there looks like it needs an answer, asks the assistant to answer it.
 *
 * - Unchanged content is never answered twice, and nothing is read while the screen is still
 *   changing. Screens that never stop changing (video tiles) are read every few seconds and
 *   answered once their text is the same on two reads.
 * - Unreadable captures are reported instead of guessed at, unless the model can see the image.
 * - MyCluely's own windows are masked out of captures by the capture pipeline.
 */
export class ScreenWatcher {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private lastSignature: Uint8Array | undefined
  private changedAt = 0
  /** Start of the current run of consecutive changed probes (0 when the last probe was unchanged). */
  private changingSince = 0
  /** The screen changed since it was last read. */
  private dirty = true
  private lastReadAt = 0
  private lastRead: Set<string> | undefined
  private handled: Set<string>[] = []
  private lastAnswerAt = 0
  private readonly t: ScreenWatcherTimings

  constructor(
    private readonly deps: ScreenWatcherDeps,
    timings: Partial<ScreenWatcherTimings> = {}
  ) {
    this.t = { ...DEFAULT_TIMINGS, ...timings }
  }

  get active(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.reset()
    this.deps.setState('watching')
    this.timer = setInterval(() => void this.tick(), this.t.probeMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Watch something else (new source or region): read it afresh; answered content stays answered. */
  reset(): void {
    this.lastSignature = undefined
    this.lastRead = undefined
    this.dirty = true
    this.lastReadAt = 0
    this.changingSince = 0
  }

  /** Forget what was answered (new meeting). */
  clearHistory(): void {
    this.handled = []
    this.lastAnswerAt = 0
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.timer) return
    this.ticking = true
    try {
      await this.step()
    } catch (err) {
      this.deps.setState('unreadable', `Screen watching failed: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  private async step(): Promise<void> {
    const probe = await this.deps.probe()
    if (!this.timer) return
    if (!probe.ok || !probe.signature) {
      this.deps.setState('unreadable', probe.error ?? 'The screen could not be captured.')
      return
    }
    const now = Date.now()
    if (isScreenChanged(this.lastSignature, probe.signature)) {
      const first = !this.lastSignature
      this.lastSignature = probe.signature
      this.dirty = true
      // The first look at a screen counts as settled: read what is already there straight away.
      this.changedAt = first ? 0 : now
      if (!first && !this.changingSince) this.changingSince = now
    } else {
      this.changingSince = 0
    }
    if (!this.dirty) return
    const settled = now - this.changedAt >= this.t.settleMs
    // A screen that has not stopped changing for a while (video next to the content) is read
    // anyway, at a slower pace; its text then has to read the same twice.
    const restless = !!this.changingSince && now - this.changingSince >= this.t.rereadMs && now - this.lastReadAt >= this.t.rereadMs
    if (!settled && !restless) {
      this.deps.setState('settling')
      return
    }
    // Wait (staying dirty) while another answer is written or the cooldown runs.
    if (this.deps.busy() || now - this.lastAnswerAt < this.deps.cooldownMs()) return
    await this.read(settled)
  }

  private async read(settled: boolean): Promise<void> {
    this.deps.setState('reading')
    const snap = await this.deps.capture()
    this.lastReadAt = Date.now()
    if (!this.timer) return
    if (!snap) {
      this.deps.setState('unreadable', 'The screen could not be captured.')
      return
    }
    const words = screenWords(snap.ocrText)
    // A screen that keeps changing is answered once its text reads the same twice.
    const textStable = settled || (!!this.lastRead && sameScreenText(this.lastRead, words))
    this.lastRead = words
    if (!textStable) {
      this.deps.setState('settling')
      return
    }
    this.dirty = false
    const sees = this.deps.seesImages()
    // Say so rather than guess: nothing readable, and the model cannot look at the image.
    if (snap.quality === 'unreadable' && !sees) {
      this.deps.setState('unreadable', snap.qualityNote ?? 'The screen text could not be read.')
      return
    }
    if (!hasNewContent(words, this.handled)) {
      this.deps.setState('nothing', 'Nothing new on screen since the last answer.')
      return
    }
    // Readable text that plainly needs no answer is skipped without asking the model. With weak
    // OCR and a vision model, the model judges from the image.
    if ((!sees || snap.quality === 'clear') && !looksAnswerable(snap.ocrText)) {
      this.remember(words)
      this.deps.setState('nothing')
      return
    }
    this.remember(words)
    this.lastAnswerAt = Date.now()
    this.deps.setState('answering')
    const result = await this.deps.answer(snap)
    if (!this.timer) return
    this.deps.setState(result === 'nothing' ? 'nothing' : 'watching')
  }

  private remember(words: Set<string>): void {
    this.handled.push(words)
    if (this.handled.length > MAX_HANDLED) this.handled.shift()
  }
}
