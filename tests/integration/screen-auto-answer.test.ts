import { afterEach, describe, expect, it } from 'vitest'
import { promptText } from '../helpers/mock-providers'
import { createHarness, waitFor, type Harness } from '../helpers/session-harness'

/**
 * Auto answer mode on the screen, through the real SessionController, real Tesseract OCR on the
 * fixture images, the real OpenAI adapter and the mock API.
 */
let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const screenAnswers = () => h!.session.meeting.record.responses.filter((r) => r.action === 'screen-answer')
const screenRequests = () => h!.mock.chatRequests().filter((r) => /Answer what needs answering on the user's screen/.test(promptText(r.body)))

describe('Auto answer mode: questions shown on screen', () => {
  it('answers a question on the watched screen without a click — once, with the screenshot', async () => {
    let shown = 0
    h = await createHarness({ settings: { assistant: { autoSuggest: 'answers', suggestionCooldownSec: 5 } }, onAutoAnswer: () => shown++ })
    h.capture.image = 'quiz.png'
    await h.session.listSources()
    await h.session.start({ title: 'Screen quiz' })
    const r = await waitFor(() => screenAnswers()[0], 30_000)
    expect(r.auto).toBe(true)
    await h.session.assistant.wait(r.id)
    const done = h.session.meeting.findResponse(r.id)!
    expect(done.status).toBe('done')
    expect(done.text).toContain('Hash table')
    expect(done.usedImage).toBe(true)
    expect(shown).toBe(1) // the answer panel is brought up
    const req = screenRequests().at(-1)!
    expect(promptText(req.body)).toContain('Which data structure gives')
    expect(promptText(req.body)).toContain('reply with exactly NOTHING_TO_ANSWER')
    expect(JSON.stringify(req.body)).toContain('input_image')

    // The same content after a repaint is not answered again.
    h.capture.shade = 90
    await waitFor(() => h!.session.getStatus().autoAnswer.screen === 'nothing', 15_000)
    await new Promise((res) => setTimeout(res, 600))
    expect(screenAnswers()).toHaveLength(1)
    expect(screenRequests()).toHaveLength(1)
  }, 90_000)

  it('does not ask the model about plain content, and shows nothing when the model finds nothing to answer', async () => {
    h = await createHarness({ settings: { assistant: { autoSuggest: 'answers', suggestionCooldownSec: 5 } } })
    h.capture.image = 'slide.png' // a slide with no question
    await h.session.listSources()
    await h.session.start({ title: 'Plain slide' })
    await waitFor(() => h!.session.getStatus().autoAnswer.screen === 'nothing', 30_000)
    expect(screenRequests()).toHaveLength(0)

    // A screen that looks answerable but isn't, per the model: no card at all.
    h.mock.options.reply = (prompt) => (/NOTHING_TO_ANSWER/.test(prompt) ? 'NOTHING_TO_ANSWER' : 'unexpected')
    h.capture.image = 'quiz.png'
    h.capture.shade = 60
    await waitFor(() => screenRequests().length === 1, 30_000)
    await waitFor(() => h!.session.getStatus().autoAnswer.screen === 'nothing', 15_000)
    expect(h.session.meeting.record.responses).toHaveLength(0)
    expect(h.events.of('response')).toHaveLength(0)
  }, 90_000)

  it('pauses and resumes, and does not watch in Manual mode', async () => {
    h = await createHarness({ settings: { assistant: { autoSuggest: 'questions' } } })
    h.capture.image = 'quiz.png'
    await h.session.listSources()
    await h.session.start({ title: 'Manual then auto' })
    await new Promise((res) => setTimeout(res, 500))
    expect(h.capture.probes).toBe(0)
    expect(h.session.getStatus().autoAnswer.screen).toBe('off')

    await h.settings.update({ assistant: { autoSuggest: 'answers' } })
    h.session.setAutoPaused(true)
    await h.session.refreshStatus()
    expect(h.session.getStatus().autoAnswer).toMatchObject({ paused: true, screen: 'paused' })
    await new Promise((res) => setTimeout(res, 500))
    expect(h.capture.probes).toBe(0)
    expect(screenAnswers()).toHaveLength(0)

    h.session.setAutoPaused(false)
    await waitFor(() => screenAnswers()[0], 30_000)
    expect(h.capture.probes).toBeGreaterThan(0)
  }, 90_000)

  it('Manual Answer answers a question shown on screen when nothing was just asked aloud', async () => {
    h = await createHarness({ settings: { assistant: { autoSuggest: 'questions' } } })
    h.capture.image = 'quiz.png'
    await h.session.listSources()
    const id = await h.session.runAction({ action: 'answer' })
    await h.session.assistant.wait(id)
    const r = h.session.meeting.findResponse(id)!
    expect(r.action).toBe('answer')
    expect(r.text).toContain('Hash table')
    const prompt = promptText(h.mock.chatRequests().at(-1)!.body)
    expect(prompt).toContain('asked in the conversation or shown on the screen')
    expect(prompt).toContain('Which data structure gives')
  }, 60_000)
})
