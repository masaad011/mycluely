import type { DetectedQuestion, TranscriptSegment } from './types'
import { newId, normalizeWords } from './util'

const WH = new Set(['what', "what's", 'whats', 'why', 'how', "how's", 'when', 'where', "where's", 'who', "who's", 'which', 'whose', 'whom'])
const AUX = new Set([
  'can', 'could', 'would', 'will', 'should', 'do', 'does', 'did', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'may', 'might', 'shall', "isn't", "aren't", "don't", "doesn't", "didn't",
  "won't", "wouldn't", "can't", "couldn't", "haven't", "hasn't"
])
const REQUEST_PHRASES = [
  'tell me', 'tell us', 'walk me through', 'walk us through', 'explain', 'describe', 'talk about',
  'thoughts on', 'what do you think', 'how about', 'any ideas', 'can you share', 'could you elaborate',
  'would you mind', "i'm curious", 'i am curious', 'i wonder', 'do you know', 'give me an example',
  'help me understand', 'what would you', 'how would you', 'your take', 'your opinion', 'any update',
  'any updates', 'where are we on', 'remind me'
]
const TAG_QUESTION = /(?:,\s*|\s)(right|okay|ok|you know|isn't it|aren't they|correct|yeah|no)\?\s*$/i

/** Split text into sentences, keeping terminal punctuation. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

/** Heuristic probability (0..1) that a sentence is a genuine question. */
export function scoreSentence(sentence: string): number {
  const s = sentence.trim()
  const words = normalizeWords(s)
  if (words.length === 0) return 0
  let score = 0
  const endsQ = /\?\s*$/.test(s)
  if (endsQ) score += 0.55
  const first = words[0]
  if (WH.has(first)) score += 0.35
  else if (AUX.has(first)) score += words.length >= 3 ? 0.3 : 0.1
  const lower = ' ' + words.join(' ') + ' '
  // Imperative requests ("Walk me through…", "Explain…") are questions even without a "?".
  if (REQUEST_PHRASES.some((p) => lower.startsWith(' ' + p + ' '))) score += 0.5
  else if (REQUEST_PHRASES.some((p) => lower.includes(' ' + p + ' '))) score += 0.3
  if (/\b(you|your|you're|yours)\b/i.test(s)) score += 0.1
  if (endsQ && TAG_QUESTION.test(s) && !WH.has(first) && !AUX.has(first)) score -= 0.45
  if (words.length < 3) score -= 0.25
  return Math.max(0, Math.min(1, score))
}

/** Score a whole transcript chunk, returning the most question-like sentence. */
export function findQuestion(text: string): { text: string; score: number } | null {
  const sentences = splitSentences(text)
  let best: { text: string; score: number } | null = null
  sentences.forEach((sentence, i) => {
    // Later sentences matter more: the question usually ends a speaker's turn.
    const recency = i === sentences.length - 1 ? 0.05 : 0
    const score = Math.min(1, scoreSentence(sentence) + recency)
    if (!best || score >= best.score) best = { text: sentence, score }
  })
  return best
}

export interface QuestionTrackerOptions {
  threshold: number
  /** User speech after a question within this window counts as answering it. */
  answerWindowMs: number
  minAnswerWords: number
  /** Questions older than this are no longer considered "latest". */
  staleMs: number
}

export const DEFAULT_QUESTION_OPTIONS: QuestionTrackerOptions = {
  threshold: 0.5,
  answerWindowMs: 45_000,
  minAnswerWords: 10,
  staleMs: 5 * 60_000
}

export interface TrackerUpdate {
  added?: DetectedQuestion
  answeredIds: string[]
}

/**
 * Follows the transcript and keeps a list of questions asked by remote participants, marking
 * them answered once the user has spoken enough after them.
 */
export class QuestionTracker {
  readonly opts: QuestionTrackerOptions
  questions: DetectedQuestion[] = []
  private lastRemote: TranscriptSegment | null = null
  private answerWords = new Map<string, number>()

  constructor(opts: Partial<QuestionTrackerOptions> = {}, initial: DetectedQuestion[] = []) {
    this.opts = { ...DEFAULT_QUESTION_OPTIONS, ...opts }
    this.questions = initial.slice()
  }

  onSegment(seg: TranscriptSegment): TrackerUpdate {
    const update: TrackerUpdate = { answeredIds: [] }
    if (seg.status !== 'ok' || !seg.text) return update

    if (seg.source === 'mic') {
      const words = normalizeWords(seg.text).length
      for (const q of this.questions) {
        if (q.status !== 'open') continue
        if (seg.startMs < this.segmentStart(q) || seg.startMs - this.segmentStart(q) > this.opts.answerWindowMs) continue
        const total = (this.answerWords.get(q.id) ?? 0) + words
        this.answerWords.set(q.id, total)
        if (total >= this.opts.minAnswerWords) {
          q.status = 'answered'
          update.answeredIds.push(q.id)
        }
      }
      return update
    }

    // Remote speech: a short fragment right after the previous remote segment is often the tail
    // of the same sentence ("...so regarding the migration" + "what's the timeline?").
    let text = seg.text
    const prev = this.lastRemote
    if (
      prev &&
      seg.startMs - prev.endMs < 1500 &&
      normalizeWords(seg.text).length <= 6 &&
      !/[.!?]\s*$/.test(prev.text)
    ) {
      text = `${prev.text} ${seg.text}`
    }
    this.lastRemote = seg

    const found = findQuestion(text)
    if (!found || found.score < this.opts.threshold) return update
    const duplicate = this.questions.find(
      (q) => q.text === found.text || (q.segmentId === prev?.id && text.includes(q.text))
    )
    if (duplicate) return update

    const q: DetectedQuestion = {
      id: newId('q'),
      segmentId: seg.id,
      text: found.text,
      speaker: seg.speaker,
      at: seg.at,
      score: Number(found.score.toFixed(2)),
      status: 'open'
    }
    this.starts.set(q.id, seg.startMs)
    this.questions.push(q)
    update.added = q
    return update
  }

  private starts = new Map<string, number>()
  private segmentStart(q: DetectedQuestion): number {
    return this.starts.get(q.id) ?? 0
  }

  /** Most recent open question that is not stale. */
  latestOpen(nowMs: number): DetectedQuestion | undefined {
    for (let i = this.questions.length - 1; i >= 0; i--) {
      const q = this.questions[i]
      if (q.status === 'open' && nowMs - q.at <= this.opts.staleMs) return q
    }
    return undefined
  }

  dismiss(id: string): void {
    const q = this.questions.find((x) => x.id === id)
    if (q) q.status = 'dismissed'
  }

  markAnswered(id: string): void {
    const q = this.questions.find((x) => x.id === id)
    if (q) q.status = 'answered'
  }
}
