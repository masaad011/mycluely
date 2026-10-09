import { promises as fs } from 'node:fs'
import type { RunActionRequest } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { AssistantResponse, DetectedQuestion, MeetingSummary, ScreenSnapshot, Toast } from '@shared/types'
import { buildContext, planRollingSummary } from '@shared/context'
import { effortFor, resolveVision } from '@shared/models'
import { NOTHING_TO_ANSWER, ROLLING_SUMMARY_SYSTEM, rollingSummaryPrompt } from '@shared/prompts'
import { sameScreenText, screenWords } from '@shared/screen-text'
import { parseSummary } from '@shared/summary'
import { formatClock, newId, sleep } from '@shared/util'
import { normalizeError } from '../providers/errors'
import type { ProviderRegistry } from '../providers/registry'
import type { ChatImage } from '../providers/types'
import type { LiveMeeting } from '../session/live-meeting'

export interface AssistantEvents {
  response(r: AssistantResponse): void
  delta(id: string, delta: string): void
  summary(s: MeetingSummary): void
  questions(q: DetectedQuestion[]): void
  toast(level: Toast['level'], message: string): void
  busy(busy: boolean): void
  changed(): void
  /** An automatic answer became visible (so the answer panel can be shown). */
  autoAnswer(r: AssistantResponse): void
}

interface RunOptions extends RunActionRequest {
  auto?: boolean
  /** Hidden until it turns out to be an answer: a reply of NOTHING_TO_ANSWER is never shown. */
  quiet?: boolean
  /** Answer without a just-asked spoken question: also consider what is on screen. */
  screenFocus?: boolean
  parentId?: string
  previousResponse?: string
}

const DELTA_FLUSH_MS = 40
/** Short pause after a question is transcribed before auto-answering, so near-simultaneous lines are seen together. */
const AUTO_SETTLE_MS = 300
/** Questions older than this are left for the user rather than answered late. */
const AUTO_MAX_AGE_MS = 90_000

/**
 * Runs assistant actions against the selected provider/model. Every request is built fresh from
 * the meeting state (transcript, rolling summary, latest screen, previous answers), so switching
 * provider or model mid-meeting keeps full context.
 */
export class AssistantService {
  private readonly active = new Map<string, AbortController>()
  private readonly done = new Map<string, Promise<void>>()
  private readonly deltaBuf = new Map<string, string>()
  private deltaTimer: NodeJS.Timeout | null = null
  private lastAutoAt = 0
  private autoTimer: NodeJS.Timeout | null = null
  private compacting = false

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly settings: () => Settings,
    private readonly meeting: () => LiveMeeting,
    private readonly events: AssistantEvents,
    /** Automatic answers only while a meeting is running or paused. */
    private readonly isLive: () => boolean = () => true
  ) {}

  get busy(): boolean {
    return this.active.size > 0
  }

  /** Start an action; returns the response id immediately and streams updates via events. */
  run(req: RunOptions): string {
    const s = this.settings()
    const provider = s.ai.provider
    const resp: AssistantResponse = {
      id: newId('r'),
      action: req.action,
      prompt: req.prompt?.trim() || undefined,
      text: '',
      status: 'streaming',
      provider,
      model: s.ai.models[provider],
      style: req.style ?? s.assistant.style,
      at: Date.now(),
      auto: req.auto,
      parentId: req.parentId,
      questionId: req.questionId,
      notes: []
    }
    if (!req.quiet) {
      this.meeting().addResponse(resp)
      this.events.response({ ...resp })
      if (req.auto && req.action !== 'summarize') this.events.autoAnswer({ ...resp })
    }
    const p = this.execute(resp, req).finally(() => this.done.delete(resp.id))
    this.done.set(resp.id, p)
    return resp.id
  }

  wait(id: string): Promise<void> {
    return this.done.get(id) ?? Promise.resolve()
  }

  regenerate(id: string): string {
    const orig = this.meeting().findResponse(id)
    if (!orig) throw new Error('Response not found')
    // A refinement regenerates against the same base answer, however often it is regenerated.
    const base = orig.action === 'refine' && orig.parentId ? this.meeting().findResponse(orig.parentId) : undefined
    return this.run({
      action: orig.action,
      prompt: orig.prompt,
      questionId: orig.questionId,
      style: orig.action === 'refine' ? orig.style : this.settings().assistant.style,
      parentId: orig.action === 'refine' ? orig.parentId : orig.id,
      previousResponse: base?.text
    })
  }

  refine(id: string, instruction: string): string {
    const orig = this.meeting().findResponse(id)
    if (!orig) throw new Error('Response not found')
    return this.run({
      action: 'refine',
      prompt: instruction,
      parentId: orig.id,
      previousResponse: orig.text,
      questionId: orig.questionId,
      style: orig.style
    })
  }

  cancel(id: string): void {
    this.active.get(id)?.abort()
  }

  cancelAll(): void {
    for (const c of this.active.values()) c.abort()
  }

  /**
   * Auto-answer: when enabled, answer the newest open question shortly after it is asked. A
   * question that arrives during the cooldown, or while another answer is still streaming, is
   * answered as soon as that allows — it is never silently dropped. Also called when auto-answer
   * is switched on, to pick up a question that was just asked.
   */
  onQuestionDetected(): void {
    if (this.settings().assistant.autoSuggest !== 'answers') return
    this.scheduleAuto(AUTO_SETTLE_MS)
  }

  /** Forget any pending automatic answer (meeting stopped or auto-answer switched off). */
  stopAuto(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = null
  }

  private scheduleAuto(delayMs: number): void {
    this.stopAuto()
    this.autoTimer = setTimeout(() => void this.autoAnswer(), Math.max(0, delayMs))
  }

  private async autoAnswer(): Promise<void> {
    this.autoTimer = null
    const s = this.settings()
    const m = this.meeting()
    if (s.assistant.autoSuggest !== 'answers' || !this.isLive()) return
    const now = Date.now()
    const q = m.tracker.latestOpen(now)
    if (!q || now - q.at > AUTO_MAX_AGE_MS) return
    // One answer at a time: wait for the one in progress, then re-check what is still open.
    const inProgress = m.record.responses.find((r) => r.action === 'answer' && r.status === 'streaming')
    if (inProgress) {
      void this.wait(inProgress.id).then(() => {
        if (!this.autoTimer && this.meeting() === m) this.scheduleAuto(0)
      })
      return
    }
    const cooldown = this.lastAutoAt + s.assistant.suggestionCooldownSec * 1000 - now
    if (cooldown > 0) return this.scheduleAuto(cooldown)
    if (!(await this.registry.isConfigured(s.ai.provider))) return
    if (q.status !== 'open' || this.meeting() !== m || !this.isLive()) return
    this.lastAutoAt = Date.now()
    this.run({ action: 'answer', questionId: q.id, auto: true })
  }

  private async execute(resp: AssistantResponse, req: RunOptions): Promise<void> {
    const controller = new AbortController()
    this.active.set(resp.id, controller)
    this.events.busy(true)
    const s = this.settings()
    const provider = resp.provider
    const model = resp.model
    const notes = resp.notes ?? (resp.notes = [])
    const meeting = this.meeting()
    let revealed = !req.quiet
    const reveal = (): void => {
      if (revealed) return
      revealed = true
      meeting.addResponse(resp)
      this.events.response({ ...resp })
      if (resp.auto) this.events.autoAnswer({ ...resp })
    }
    try {
      const client = await this.registry.get(provider)
      const info = await this.registry.modelInfo(provider, model)
      const { vision } = resolveVision(info, provider, model, s.ai.visionOverrides)
      const m = this.meeting()

      let questionText: string | undefined
      if (req.action === 'answer') {
        // With screenFocus the controller found no recent spoken question: let the model pick
        // between the conversation and the screen rather than reviving an older one.
        const q = req.questionId
          ? m.questions.find((x) => x.id === req.questionId)
          : req.screenFocus
            ? undefined
            : m.tracker.latestOpen(Date.now())
        if (q) {
          questionText = q.text
          resp.questionId = q.id
          if (q.status === 'open') {
            m.tracker.markAnswered(q.id)
            this.events.questions(m.questions.map((x) => ({ ...x })))
          }
        }
      }

      const snapshot = m.latestSnapshot()
      let imageAvailable = false
      if (snapshot?.imagePath) imageAvailable = await fs.access(snapshot.imagePath).then(() => true, () => false)
      const ctxWindow = info?.contextWindow ?? 128_000
      const budget = Math.max(3000, Math.min(s.ai.maxContextTokens, ctxWindow * 0.8 - s.ai.maxOutputTokens))
      const built = buildContext({
        action: req.action,
        mode: m.record.mode,
        style: resp.style,
        meetingTitle: m.record.title,
        startedAt: m.started ? m.record.startedAt : undefined,
        now: Date.now(),
        segments: m.record.segments,
        rollingSummary: m.record.rollingSummary,
        summarizedCount: m.summarizedCount,
        snapshot: snapshot && !imageAvailable ? { ...snapshot, imagePath: undefined } : snapshot,
        previousResponses: m.record.responses.filter((r) => r.id !== resp.id),
        previousSnapshot: req.action === 'screen-answer' ? previousScreen(m.record.snapshots, snapshot) : undefined,
        automatic: req.auto,
        screenFocus: req.screenFocus,
        questionText,
        userPrompt: req.prompt,
        previousResponse: req.previousResponse,
        customInstructions: s.assistant.customInstructions,
        userContext: s.assistant.userContext,
        budgetTokens: budget,
        modelVision: vision && s.ai.imagePolicy !== 'never',
        imagePolicy: s.ai.imagePolicy,
        speed: s.ai.speed
      })
      notes.push(...built.notes)
      resp.screenId = snapshot?.id
      let image: ChatImage | undefined
      if (built.attachImage && snapshot?.imagePath) {
        image = { mimeType: 'image/jpeg', base64: (await fs.readFile(snapshot.imagePath)).toString('base64') }
        resp.usedImage = true
      }
      if (revealed) this.events.response({ ...resp, text: resp.text })

      let emitted = false
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await client.stream({
            model,
            system: built.system,
            user: built.user,
            image,
            maxOutputTokens: s.ai.maxOutputTokens,
            effort: effortFor(req.action, resp.style, s.ai.speed),
            signal: controller.signal,
            timeoutMs: s.ai.requestTimeoutSec * 1000,
            onDelta: (d) => {
              emitted = true
              resp.firstTokenMs ??= Date.now() - resp.at
              resp.text += d
              if (!revealed) {
                // Stay hidden while the reply could still be NOTHING_TO_ANSWER; the reveal carries the text so far.
                const t = resp.text.trimStart()
                if (t.startsWith(NOTHING_TO_ANSWER) || NOTHING_TO_ANSWER.startsWith(t)) return
                reveal()
                return
              }
              this.queueDelta(resp.id, d)
            }
          })
          this.flushDeltas()
          if (result.finish === 'length') notes.push('Response was cut off at the output token limit.')
          if (result.finish === 'refusal') notes.push('The model declined (part of) this request.')
          if (result.notes) notes.push(...result.notes)
          break
        } catch (err) {
          const e = normalizeError(provider, err)
          // Retry transient failures once, but only if nothing was shown yet.
          if (!emitted && e.retryable && attempt < 2 && !controller.signal.aborted) {
            const wait = Math.min(e.retryAfterMs ?? 2000, 15_000)
            notes.push(`${e.userMessage} Retrying…`)
            if (revealed) this.events.response({ ...resp })
            await sleep(wait, controller.signal)
            notes.pop()
            continue
          }
          throw e
        }
      }

      if (!revealed) {
        // Automatic screen answer: the model found nothing that needs an answer. Never shown.
        resp.status = 'done'
        resp.text = ''
      } else if (!resp.text.trim()) {
        resp.status = 'error'
        resp.error = 'The model returned an empty response.'
      } else {
        resp.status = 'done'
        resp.totalMs = Date.now() - resp.at
        if (req.action === 'summarize') {
          const summary = parseSummary(resp.text)
          m.record.summary = summary
          m.record.hasSummary = true
          this.events.summary(summary)
        }
      }
    } catch (err) {
      this.flushDeltas()
      const e = normalizeError(provider, err)
      if (e.kind === 'aborted' || controller.signal.aborted) {
        resp.status = 'cancelled'
      } else {
        resp.status = 'error'
        resp.error = e.userMessage
        if (e.kind === 'not_configured' || e.kind === 'auth') this.events.toast('warning', e.userMessage)
        reveal() // failures of automatic answers are shown too
      }
    } finally {
      this.active.delete(resp.id)
      if (revealed) this.events.response({ ...resp })
      this.events.busy(this.active.size > 0)
      this.events.changed()
    }
  }

  private queueDelta(id: string, delta: string): void {
    this.deltaBuf.set(id, (this.deltaBuf.get(id) ?? '') + delta)
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS)
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    for (const [id, delta] of this.deltaBuf) if (delta) this.events.delta(id, delta)
    this.deltaBuf.clear()
  }

  /**
   * Keep long meetings within the context budget: fold the oldest unsummarised transcript into a
   * running summary in the background. Failures are silent — prompts then just drop old lines.
   */
  async maybeCompact(): Promise<void> {
    if (this.compacting) return
    const s = this.settings()
    const m = this.meeting()
    const plan = planRollingSummary(m.record.segments, m.summarizedCount, s.ai.maxContextTokens * 0.7)
    if (!plan) return
    if (!(await this.registry.isConfigured(s.ai.provider))) return
    this.compacting = true
    try {
      const ok = m.record.segments.filter((x) => x.status === 'ok' && x.text.trim())
      const slice = ok.slice(plan.from, plan.to)
      const text = slice.map((x) => `[${formatClock(x.startMs)}] ${x.speaker}: ${x.text}`).join('\n')
      const client = await this.registry.get(s.ai.provider)
      const result = await client.stream({
        model: s.ai.models[s.ai.provider],
        system: ROLLING_SUMMARY_SYSTEM,
        user: rollingSummaryPrompt(m.record.rollingSummary ?? '', text),
        maxOutputTokens: 1200,
        effort: 'low',
        signal: AbortSignal.timeout(120_000),
        timeoutMs: 120_000,
        onDelta: () => undefined
      })
      if (result.text.trim() && this.meeting() === m) {
        m.record.rollingSummary = result.text.trim()
        m.summarizedCount = plan.to
        this.events.changed()
      }
    } catch {
      // Non-fatal.
    } finally {
      this.compacting = false
    }
  }
}

/** The latest earlier capture that showed something else (for questions that span screens). */
function previousScreen(snapshots: ScreenSnapshot[], current: ScreenSnapshot | undefined): ScreenSnapshot | undefined {
  if (!current) return undefined
  const words = screenWords(current.ocrText)
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i]
    if (s.id === current.id || s.at > current.at || !s.ocrText.trim()) continue
    if (!sameScreenText(screenWords(s.ocrText), words)) return s
  }
  return undefined
}
