import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * Readability: answers, questions, transcript and code are visually distinct, labelled, and keep
 * at least 4.5:1 contrast in every theme; code is highlighted, labelled and copyable.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']
let app: ElectronApplication
let main: Page
let mock: MockServer
let userData: string

test.beforeAll(async () => {
  mock = await startMockProviders({ transcripts: ['What is the rollback plan for the Postgres migration?'] })
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-read-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { micEnabled: false, systemEnabled: false },
      // Spoken questions only (never reads the desktop); Manual answering.
      assistant: { autoSuggest: 'questions', autoScreen: false },
      privacy: { consentReminder: false }
    })
  )
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', MYCLUELY_TEST_HOOKS: '1', OPENAI_API_KEY: 'sk-read', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  await app.firstWindow()
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
  main = app.windows().find((w) => w.url().endsWith('index.html'))!
  await expect(main.getByTestId('panel-assistant')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await mock?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('content colours keep at least 4.5:1 contrast in every theme', async () => {
  const failures = await main.evaluate(`(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const colour = (v) => { probe.style.color = 'var(' + v + ')'; return getComputedStyle(probe).color }
    const html = document.documentElement
    const original = html.dataset.theme
    const out = []
    for (const theme of ['light', 'paper', 'dark', 'midnight', 'slate', 'black', 'contrast']) {
      html.dataset.theme = theme
      const panel = colour('--panel'), code = colour('--code-bg')
      for (const t of ['--t-answer', '--t-ask', '--t-question', '--t-suggest', '--t-screen', '--t-summary', '--you', '--remote']) {
        const r = ratio(colour(t), panel); if (r < 4.5) out.push(theme + ' ' + t + ' ' + r.toFixed(2))
      }
      for (const t of ['--syn-keyword', '--syn-string', '--syn-number', '--syn-comment', '--syn-title', '--syn-type', '--syn-attr', '--syn-meta', '--syn-tag', '--syn-regexp', '--text']) {
        const r = ratio(colour(t), code); if (r < 4.5) out.push(theme + ' ' + t + ' on code ' + r.toFixed(2))
      }
    }
    html.dataset.theme = original
    probe.remove()
    return out
  })()`)
  expect(failures).toEqual([])
})

test('questions, answers, your questions and code are labelled and distinct', async () => {
  // A question asked aloud is tagged in the transcript…
  await main.getByTestId('start').click()
  const wav = Array.from(readFileSync(path.join(root, 'tests/fixtures/question.wav')))
  await app.evaluate(({}, wav) => {
    const t = (globalThis as unknown as { __mycluelyTest: { controller: { meeting: { record: { startedAt: number } }; onAudioSegment: (m: unknown) => void } } }).__mycluelyTest
    t.controller.onAudioSegment({ source: 'system', startedAt: t.controller.meeting.record.startedAt + 2000, durationMs: 4000, peakDb: -10, wav: new Uint8Array(wav) })
  }, wav)
  const tag = main.getByTestId('segment').first().getByTestId('question-tag')
  await expect(tag).toHaveText('Question')

  // …its answer shows who asked what, in a question block above the answer…
  await main.getByTestId('action-answer').click()
  const answer = main.getByTestId('response').first()
  await expect(answer).toHaveAttribute('data-status', 'done')
  await expect(answer).toHaveAttribute('data-tone', 'answer')
  await expect(answer.getByTestId('response-type')).toHaveText('Answer')
  await expect(answer.getByTestId('response-prompt')).toContainText('Remote asked')
  await expect(answer.getByTestId('response-prompt')).toContainText('What is the rollback plan')
  await expect(tag).toHaveText('Answered')

  // …a typed question is shown as such, and code comes highlighted, labelled and copyable.
  await main.getByTestId('ask-input').fill('Show me the code for evicting cache keys')
  await main.getByTestId('ask-input').press('Enter')
  const asked = main.getByTestId('response').first()
  await expect(asked).toHaveAttribute('data-status', 'done')
  await expect(asked).toHaveAttribute('data-tone', 'ask')
  await expect(asked.getByTestId('response-prompt')).toContainText('You asked')
  const block = asked.getByTestId('code-block')
  await expect(block.getByTestId('code-lang')).toHaveText('TypeScript')
  expect(await block.locator('.hljs-keyword').count()).toBeGreaterThan(3)
  await expect(block.locator('.hljs-comment')).toContainText('Evict cached rows')
  expect(await main.evaluate<string>("getComputedStyle(document.querySelector('[data-testid=code-block] pre code')).fontFamily")).toMatch(/Cascadia|Consolas|monospace/i)
  await expect(asked.locator('table')).toBeVisible()

  // Answer and your-question cards use different colours.
  const typeColours = await main.evaluate<string[]>("[...document.querySelectorAll('[data-testid=response-type]')].map((e) => getComputedStyle(e).color)")
  expect(new Set(typeColours).size).toBe(2)

  await block.getByRole('button', { name: 'Copy code' }).click()
  const copied = () => app.evaluate(() => (globalThis as unknown as { __mycluelyTest: { clipboard: string[] } }).__mycluelyTest.clipboard.at(-1))
  await expect.poll(copied).toContain('export async function onChange(event: ChangeEvent)')
  await main.getByTestId('stop').click()
})
