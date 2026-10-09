import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenWatcher, type ScreenWatcherDeps } from '../../src/main/session/screen-watcher'
import type { ScreenSnapshot, ScreenWatchState } from '../../src/shared/types'

const QUESTION = 'Interview Question 3\nWhich data structure gives O(1) average lookup by key?\nA) Linked list  B) Hash table'
const NEXT_QUESTION = 'Interview Question 4\nWhat is the worst-case time complexity of quicksort and why?'
const PLAIN = 'Quarterly Revenue Review\nQ3 revenue grew 18 percent to 4.2 million dollars'

/** A fake screen: `shade` drives the change signature (steps well above sensor noise), `text`/`quality` what OCR reads. */
function fakeScreen(over: Partial<ScreenWatcherDeps> = {}) {
  const screen = { shade: 10, text: QUESTION, quality: 'clear' as ScreenSnapshot['quality'], sees: true, busy: false, cooldown: 0 }
  const answers: string[] = []
  const states: ScreenWatchState[] = []
  let captures = 0
  const deps: ScreenWatcherDeps = {
    probe: async () => ({ ok: true, signature: new Uint8Array(160 * 90).fill(screen.shade) }),
    capture: async () => {
      captures++
      return { id: `s${captures}`, at: Date.now(), trigger: 'auto', sourceId: 'x', sourceName: 'X', sourceKind: 'screen', width: 1, height: 1, ocrText: screen.text, ocrConfidence: 90, quality: screen.quality }
    },
    answer: async (snap) => {
      answers.push(snap.ocrText)
      return 'answered'
    },
    seesImages: () => screen.sees,
    busy: () => screen.busy,
    cooldownMs: () => screen.cooldown,
    setState: (s) => void (states.at(-1) !== s && states.push(s)),
    ...over
  }
  return { screen, answers, states, deps, captures: () => captures }
}

let watcher: ScreenWatcher | undefined
afterEach(() => watcher?.stop())
const fast = { probeMs: 15, settleMs: 40, rereadMs: 120 }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('screen watcher (Auto answer mode)', () => {
  it('answers a visible question once, and new content once it has settled', async () => {
    const f = fakeScreen()
    watcher = new ScreenWatcher(f.deps, fast)
    watcher.start()
    await vi.waitFor(() => expect(f.answers).toEqual([QUESTION]))
    // Unchanged screen (or the same text after a repaint) is not answered again.
    f.screen.shade = 70
    await pause(250)
    expect(f.answers).toHaveLength(1)
    // The next question is answered — only after the screen has stopped changing.
    f.screen.text = NEXT_QUESTION
    f.screen.shade = 130
    await vi.waitFor(() => expect(f.answers).toEqual([QUESTION, NEXT_QUESTION]))
    expect(f.states).toContain('settling')
  })

  it('does not read while the screen keeps changing, unless its text is stable (video next to a question)', async () => {
    const f = fakeScreen()
    watcher = new ScreenWatcher(f.deps, { ...fast, rereadMs: 100 })
    watcher.start()
    await vi.waitFor(() => expect(f.answers).toHaveLength(1))
    // Pixels change on every probe (video) while the text shows a new question.
    f.screen.text = NEXT_QUESTION
    const video = setInterval(() => (f.screen.shade = (f.screen.shade + 60) % 240), 5)
    try {
      await vi.waitFor(() => expect(f.answers).toEqual([QUESTION, NEXT_QUESTION]), { timeout: 3000 })
    } finally {
      clearInterval(video)
    }
    // It needed two reads with the same text before answering.
    expect(f.captures()).toBeGreaterThanOrEqual(3)
  })

  it('skips plain content without asking the model, and reports unreadable screens instead of guessing', async () => {
    const f = fakeScreen()
    f.screen.text = PLAIN
    watcher = new ScreenWatcher(f.deps, fast)
    watcher.start()
    await vi.waitFor(() => expect(f.states).toContain('nothing'))
    expect(f.answers).toHaveLength(0)

    // Unreadable and the model can't see images: say so, don't answer.
    f.screen.text = ''
    f.screen.quality = 'unreadable'
    f.screen.sees = false
    f.screen.shade = 90
    await vi.waitFor(() => expect(f.states.at(-1)).toBe('unreadable'))
    expect(f.answers).toHaveLength(0)

    // With a vision model the model reads the image itself.
    f.screen.text = 'garbled ~~ text ## here'
    f.screen.sees = true
    f.screen.shade = 170
    await vi.waitFor(() => expect(f.answers).toEqual(['garbled ~~ text ## here']))
  })

  it('waits while another answer is written and for the cooldown, and stops when told to', async () => {
    const f = fakeScreen()
    f.screen.busy = true
    watcher = new ScreenWatcher(f.deps, fast)
    watcher.start()
    await pause(150)
    expect(f.answers).toHaveLength(0)
    f.screen.busy = false
    await vi.waitFor(() => expect(f.answers).toHaveLength(1))

    f.screen.cooldown = 400
    f.screen.text = NEXT_QUESTION
    f.screen.shade = 90
    await pause(200)
    expect(f.answers).toHaveLength(1) // still in the cooldown
    await vi.waitFor(() => expect(f.answers).toHaveLength(2), { timeout: 2000 })

    watcher.stop()
    f.screen.text = 'Q5: Explain eventual consistency in two sentences.'
    f.screen.shade = 200
    await pause(200)
    expect(f.answers).toHaveLength(2)
    expect(watcher.active).toBe(false)
  })
})
