import type {
  AssistantResponse,
  DetectedQuestion,
  MeetingMode,
  MeetingRecord,
  ProviderId,
  ScreenSnapshot,
  TranscriptSegment
} from '@shared/types'
import { QuestionTracker, type TrackerUpdate } from '@shared/questions'
import { newId } from '@shared/util'

const MAX_SNAPSHOTS_IN_MEMORY = 300
/** Only recent captures keep their preview image; older ones keep OCR text and metadata. */
const THUMBNAILS_KEPT = 20

/** In-memory state of the meeting currently shown in the app (live, or the last one finished). */
export class LiveMeeting {
  readonly record: MeetingRecord
  readonly tracker: QuestionTracker
  /** Number of leading transcript segments folded into `record.rollingSummary`. */
  summarizedCount = 0
  /** Whether this meeting is written to disk (history enabled when it started). */
  persist: boolean
  /** Whether the meeting was started (drafts exist before the first Start). */
  started: boolean

  constructor(opts: {
    title?: string
    mode: MeetingMode
    provider: ProviderId
    model: string
    persist: boolean
    started: boolean
    record?: MeetingRecord
  }) {
    this.record = opts.record ?? {
      id: `${new Date().toISOString().slice(0, 10)}_${newId()}`,
      title: opts.title?.trim() || defaultTitle(),
      mode: opts.mode,
      startedAt: Date.now(),
      durationMs: 0,
      segmentCount: 0,
      provider: opts.provider,
      model: opts.model,
      hasSummary: false,
      segments: [],
      responses: [],
      questions: [],
      snapshots: []
    }
    this.persist = opts.persist
    this.started = opts.started
    this.tracker = new QuestionTracker({}, this.record.questions)
    this.record.questions = this.tracker.questions
  }

  get id(): string {
    return this.record.id
  }

  get questions(): DetectedQuestion[] {
    return this.tracker.questions
  }

  /** Insert keeping chronological order (transcription can finish out of order). */
  addSegment(seg: TranscriptSegment): TrackerUpdate {
    const segs = this.record.segments
    let i = segs.length
    while (i > 0 && segs[i - 1].startMs > seg.startMs) i--
    segs.splice(i, 0, seg)
    this.record.segmentCount = segs.length
    const update = this.tracker.onSegment(seg)
    if (update.added) seg.questionId = update.added.id
    return update
  }

  removeSegment(id: string): TranscriptSegment | undefined {
    const i = this.record.segments.findIndex((s) => s.id === id)
    if (i < 0) return undefined
    const [seg] = this.record.segments.splice(i, 1)
    this.record.segmentCount = this.record.segments.length
    return seg
  }

  recentText(maxChars = 600): string {
    let out = ''
    for (let i = this.record.segments.length - 1; i >= 0 && out.length < maxChars; i--) {
      const s = this.record.segments[i]
      if (s.status === 'ok') out = `${s.text} ${out}`
    }
    return out.trim().slice(-maxChars)
  }

  addResponse(r: AssistantResponse): void {
    this.record.responses.push(r)
  }

  addSnapshot(s: ScreenSnapshot): ScreenSnapshot[] {
    const snaps = this.record.snapshots
    snaps.push(s)
    if (snaps.length > THUMBNAILS_KEPT) delete snaps[snaps.length - 1 - THUMBNAILS_KEPT].thumbnail
    const evicted: ScreenSnapshot[] = []
    while (snaps.length > MAX_SNAPSHOTS_IN_MEMORY) evicted.push(snaps.shift()!)
    return evicted
  }

  latestSnapshot(): ScreenSnapshot | undefined {
    return this.record.snapshots[this.record.snapshots.length - 1]
  }

  findResponse(id: string): AssistantResponse | undefined {
    return this.record.responses.find((r) => r.id === id)
  }
}

export function defaultTitle(now = new Date()): string {
  const day = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `Meeting — ${day}, ${time}`
}
