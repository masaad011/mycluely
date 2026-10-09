import type { ImagePolicy, ResponseSpeed } from './settings'
import {
  BASE_SYSTEM_PROMPT,
  MODE_PROMPTS,
  STYLE_PROMPTS,
  actionInstruction
} from './prompts'
import type {
  AssistantAction,
  AssistantResponse,
  MeetingMode,
  ResponseStyle,
  ScreenSnapshot,
  TranscriptSegment
} from './types'
import { parseSuggestedQuestions } from './suggestions'
import { estimateTokens, formatClock, truncate } from './util'

export interface ContextInput {
  action: AssistantAction
  mode: MeetingMode
  style: ResponseStyle
  meetingTitle?: string
  startedAt?: number
  now: number
  segments: TranscriptSegment[]
  rollingSummary?: string
  /** Number of leading segments already covered by `rollingSummary`. */
  summarizedCount?: number
  snapshot?: ScreenSnapshot
  previousResponses?: AssistantResponse[]
  /** For screen answers: the capture before `snapshot`, when it showed something else. */
  previousSnapshot?: ScreenSnapshot
  /** Started by Auto answer mode rather than a click. */
  automatic?: boolean
  /** Answer with no question just asked aloud: the screen may hold the question (send it like Explain screen). */
  screenFocus?: boolean
  questionText?: string
  userPrompt?: string
  previousResponse?: string
  customInstructions?: string
  userContext?: string
  /** Max tokens for the whole prompt (system + user). */
  budgetTokens: number
  modelVision: boolean
  imagePolicy: ImagePolicy
  /** `fast`: with the 'auto' policy, screenshots go only with Explain screen. */
  speed?: ResponseSpeed
}

export interface BuiltContext {
  system: string
  user: string
  attachImage: boolean
  notes: string[]
  transcriptLines: number
  omittedLines: number
  estimatedTokens: number
}

const MAX_SCREEN_TOKENS = 2500
const MAX_HISTORY_TOKENS = 700
/** Earlier suggestions listed for "Questions to ask" so new ones are different. */
const MAX_SUGGESTED_HISTORY = 12
const SCREEN_RELEVANCE_MS = 15 * 60_000
/** Screen answers also see the previous capture when it is this recent. */
const PREVIOUS_SCREEN_MS = 5 * 60_000
const MAX_PREVIOUS_SCREEN_TOKENS = 600
/** With the 'auto' policy, screenshots older than this are described by OCR text only. */
const AUTO_IMAGE_MAX_AGE_MS = 2 * 60_000

export function buildSystemPrompt(input: Pick<ContextInput, 'mode' | 'style' | 'customInstructions' | 'userContext'>): string {
  const parts = [BASE_SYSTEM_PROMPT, MODE_PROMPTS[input.mode], STYLE_PROMPTS[input.style]]
  if (input.userContext?.trim()) parts.push(`About the user: ${input.userContext.trim()}`)
  if (input.customInstructions?.trim()) parts.push(`Additional instructions from the user: ${input.customInstructions.trim()}`)
  return parts.join('\n\n')
}

function ageLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  return `${Math.round(ms / 60_000)} min ago`
}

export function describeScreenQuality(s: ScreenSnapshot): string {
  switch (s.quality) {
    case 'clear':
      return `clear (OCR confidence ${Math.round(s.ocrConfidence)}%)`
    case 'partial':
      return `partially readable (OCR confidence ${Math.round(s.ocrConfidence)}%) — some text may be wrong or missing`
    case 'unreadable':
      return `unreadable — ${s.qualityNote ?? 'little or no text could be recognised'}`
    default:
      return 'not yet analysed'
  }
}

export function buildContext(input: ContextInput): BuiltContext {
  const notes: string[] = []
  const system = buildSystemPrompt(input)
  const task = actionInstruction({
    action: input.action,
    questionText: input.questionText,
    userPrompt: input.userPrompt,
    previousResponse: input.previousResponse,
    automatic: input.automatic,
    screenFocus: input.screenFocus
  })

  // --- Meeting header
  const elapsed = input.startedAt ? formatClock(input.now - input.startedAt) : 'unknown'
  const header = [
    '<meeting>',
    `Title: ${input.meetingTitle || 'Untitled meeting'}`,
    `Elapsed: ${elapsed}`,
    '</meeting>'
  ].join('\n')

  // --- Screen
  let screenBlock = ''
  let attachImage = false
  const snap = input.snapshot
  // Explaining or answering the screen: the screen is the subject, not just context.
  const screenSubject = input.action === 'explain-screen' || input.action === 'screen-answer' || (input.action === 'answer' && !!input.screenFocus && !input.questionText)
  const screenRelevant = !!snap && (screenSubject || input.now - snap.at <= SCREEN_RELEVANCE_MS)
  if (snap && screenRelevant) {
    const explaining = screenSubject
    const fresh = input.now - snap.at <= AUTO_IMAGE_MAX_AGE_MS
    const wantsImage =
      input.imagePolicy === 'always' ||
      (input.imagePolicy === 'explain' && explaining) ||
      // auto: always for screen explanations; otherwise only when OCR alone is not trustworthy —
      // and not at all at "Fastest" speed, where an image would slow every answer down.
      (input.imagePolicy === 'auto' && (explaining || (input.speed !== 'fast' && fresh && snap.quality !== 'clear')))
    attachImage = wantsImage && input.modelVision && !!snap.imagePath
    let ocr = snap.ocrText.trim()
    if (estimateTokens(ocr) > MAX_SCREEN_TOKENS) {
      ocr = truncate(ocr, MAX_SCREEN_TOKENS * 4)
      notes.push('Long screen text was truncated.')
    }
    screenBlock = [
      `<screen source="${escapeAttr(snap.sourceName)}" captured="${ageLabel(input.now - snap.at)}" quality="${describeScreenQuality(snap)}"${attachImage ? ' image="attached"' : ''}>`,
      ocr || '(no text recognised on screen)',
      '</screen>'
    ].join('\n')
    // Quality warnings matter when the screen is the subject and the model only had OCR text;
    // the prompt itself always tells the model how reliable the screen text is.
    if (explaining && !attachImage) {
      if (snap.quality === 'unreadable') notes.push('Screen content was unreadable — the explanation may be incomplete.')
      else if (snap.quality === 'partial') notes.push(`Screen text only partially readable (OCR ${Math.round(snap.ocrConfidence)}%).`)
    }
  } else if (screenSubject) {
    notes.push('No screen capture available.')
    screenBlock = '<screen>(no screen capture is available — say so)</screen>'
  }
  if (screenSubject && snap && !input.modelVision) {
    notes.push('Selected model has no image input — used OCR text only.')
  }

  // --- Previous assistant responses (for continuity, newest last)
  let historyBlock = ''
  const prev = (input.previousResponses ?? []).filter((r) => r.status === 'done' && r.text.trim())
  if (prev.length && input.action !== 'refine') {
    const items: string[] = []
    let used = 0
    for (let i = prev.length - 1; i >= 0 && items.length < 3; i--) {
      const r = prev[i]
      const line = `- (${r.action}${r.prompt ? `: ${truncate(r.prompt, 80)}` : ''}) ${truncate(r.text.replace(/\s+/g, ' '), 400)}`
      const t = estimateTokens(line)
      if (used + t > MAX_HISTORY_TOKENS) break
      used += t
      items.unshift(line)
    }
    if (items.length) historyBlock = ['<your_previous_responses>', ...items, '</your_previous_responses>'].join('\n')
  }

  // --- Questions already suggested this meeting, so "Questions to ask" keeps offering new ones.
  let suggestedBlock = ''
  if (input.action === 'suggest') {
    const seen = new Set<string>()
    const listed: string[] = []
    const earlier = (input.previousResponses ?? []).filter((r) => r.action === 'suggest' && r.status === 'done')
    for (let i = earlier.length - 1; i >= 0 && listed.length < MAX_SUGGESTED_HISTORY; i--) {
      for (const { question } of parseSuggestedQuestions(earlier[i].text)) {
        const key = question.toLowerCase()
        if (seen.has(key) || listed.length >= MAX_SUGGESTED_HISTORY) continue
        seen.add(key)
        listed.push(`- ${truncate(question, 160)}`)
      }
    }
    if (listed.length) suggestedBlock = ['<already_suggested_questions>', ...listed, '</already_suggested_questions>'].join('\n')
  }

  // --- The screen before this one, for questions that continue across screens.
  let previousScreenBlock = ''
  const prevSnap = input.previousSnapshot
  if (input.action === 'screen-answer' && prevSnap && prevSnap.ocrText.trim() && input.now - prevSnap.at <= PREVIOUS_SCREEN_MS) {
    previousScreenBlock = [
      `<previous_screen captured="${ageLabel(input.now - prevSnap.at)}">`,
      truncate(prevSnap.ocrText.trim(), MAX_PREVIOUS_SCREEN_TOKENS * 4),
      '</previous_screen>'
    ].join('\n')
  }

  // --- Rolling summary
  const summaryBlock = input.rollingSummary?.trim()
    ? ['<earlier_discussion_summary>', input.rollingSummary.trim(), '</earlier_discussion_summary>'].join('\n')
    : ''

  const taskBlock = ['<task>', task, '</task>'].join('\n')

  // --- Transcript fills the remaining budget, newest first.
  const fixed = [system, header, summaryBlock, previousScreenBlock, screenBlock, historyBlock, suggestedBlock, taskBlock].join('\n')
  const imageTokens = attachImage ? 1600 : 0
  let remaining = input.budgetTokens - estimateTokens(fixed) - imageTokens - 50
  const okSegs = input.segments.filter((s) => s.status === 'ok' && s.text.trim())
  const start = Math.min(input.summarizedCount ?? 0, okSegs.length)
  const lines: string[] = []
  let idx = okSegs.length - 1
  for (; idx >= 0; idx--) {
    const s = okSegs[idx]
    const line = `[${formatClock(s.startMs)}] ${s.speaker}: ${s.text.trim()}`
    const t = estimateTokens(line) + 1
    // Always keep at least the last few lines, even on a tiny budget.
    if (t > remaining && lines.length >= 4) break
    // Lines already covered by the rolling summary are only included if there is room.
    if (idx < start && t > remaining) break
    remaining -= t
    lines.unshift(line)
  }
  const omitted = idx + 1
  let transcriptBlock: string
  if (!okSegs.length) {
    transcriptBlock = '<transcript>\n(no speech has been transcribed yet)\n</transcript>'
    if (input.action === 'answer' || input.action === 'summarize' || input.action === 'suggest') notes.push('No transcript yet.')
  } else {
    const gap = omitted > 0
      ? `[… ${omitted} earlier line${omitted === 1 ? '' : 's'} not shown${summaryBlock ? '; see summary above' : ''} …]\n`
      : ''
    transcriptBlock = `<transcript>\n${gap}${lines.join('\n')}\n</transcript>`
    if (omitted > 0) notes.push(summaryBlock ? 'Earlier discussion included as a summary.' : `Oldest ${omitted} transcript lines omitted to fit the context limit.`)
  }

  // Stable content first (summary, then the append-only transcript) and per-request details last,
  // so providers with prompt caching can reuse the shared prefix between requests.
  const user = [summaryBlock, transcriptBlock, header, previousScreenBlock, screenBlock, historyBlock, suggestedBlock, taskBlock]
    .filter(Boolean)
    .join('\n\n')

  return {
    system,
    user,
    attachImage,
    notes,
    transcriptLines: lines.length,
    omittedLines: omitted,
    estimatedTokens: estimateTokens(system) + estimateTokens(user) + imageTokens
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, '')
}

/** Choose the transcript slice that should be folded into the rolling summary, if any. */
export function planRollingSummary(
  segments: TranscriptSegment[],
  summarizedCount: number,
  transcriptBudgetTokens: number
): { from: number; to: number } | null {
  const ok = segments.filter((s) => s.status === 'ok' && s.text.trim())
  if (summarizedCount >= ok.length) return null
  let tokens = 0
  for (let i = summarizedCount; i < ok.length; i++) tokens += estimateTokens(ok[i].text) + 8
  if (tokens < transcriptBudgetTokens * 0.6) return null
  // Fold the older half of the unsummarised lines.
  let acc = 0
  let to = summarizedCount
  while (to < ok.length && acc < tokens / 2) {
    acc += estimateTokens(ok[to].text) + 8
    to++
  }
  return { from: summarizedCount, to }
}
