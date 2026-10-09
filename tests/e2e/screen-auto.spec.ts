import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promptText, startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * Auto answer mode on the screen in the real app: a question shown in a (fixture) window is
 * answered without any click, the status shows what is watched, and Pause / Manual stop it.
 * Only the fixture window is watched — never the real desktop.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']
let app: ElectronApplication
let main: Page
let mock: MockServer
let userData: string

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  main.evaluate(([c, a]) => (globalThis as unknown as { mycluely: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mycluely.invoke(c as string, ...(a as unknown[])), [channel, args] as const) as Promise<T>

async function showImageWindow(title: string, file: string): Promise<string> {
  await app.evaluate(
    async ({ BrowserWindow }, { title, file }) => {
      const w = new BrowserWindow({ width: 1100, height: 680, x: 40, y: 40, title, focusable: false, skipTaskbar: true, autoHideMenuBar: true })
      w.setMenuBarVisibility(false)
      w.on('page-title-updated', (e) => e.preventDefault())
      await w.loadFile(file)
      await new Promise((r) => setTimeout(r, 400)) // let it paint
    },
    { title, file: path.join(root, 'tests/fixtures', file) }
  )
  let id: string | undefined
  await expect
    .poll(async () => {
      const sources = await invoke<{ id: string; name: string; kind: string }[]>('screen:sources')
      id = sources.find((s) => s.kind === 'window' && s.name === title)?.id
      return !!id
    })
    .toBe(true)
  return id!
}

test.beforeAll(async () => {
  mock = await startMockProviders()
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-screen-auto-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { systemEnabled: false, micEnabled: false },
      assistant: { suggestionCooldownSec: 5 },
      privacy: { consentReminder: false }
    })
  )
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: 'sk-screen-auto', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  await app.firstWindow()
  await expect.poll(() => ['index.html', 'overlay.html'].every((p) => app.windows().some((w) => w.url().endsWith(p)))).toBe(true)
  main = app.windows().find((w) => w.url().endsWith('index.html'))!
  await main.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await mock?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('answers a question shown in the watched window automatically, and can be paused', async () => {
  test.setTimeout(120_000)
  const overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
  // Watch only the fixture window, before anything is switched to Auto.
  await invoke('screen:select', await showImageWindow('Interview quiz', 'quiz.png'))

  const bar = main.getByTestId('answer-mode')
  const status = main.getByTestId('auto-status')
  await expect(status).toHaveAttribute('data-state', 'manual')
  await bar.getByRole('radio', { name: 'Auto' }).click()
  await expect(status).toHaveAttribute('data-state', 'waiting') // until the meeting starts
  await expect(overlay.getByTestId('answer-mode').getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')

  await main.getByTestId('start').click()
  // No click: the question on screen is read and answered.
  const card = main.getByTestId('response').first()
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  await expect(card).toContainText('Answer from screen')
  await expect(card).toContainText('Hash table')
  await expect(card).toContainText('auto')
  await expect(overlay.getByTestId('response').first()).toContainText('Hash table')
  const prompt = promptText(mock.chatRequests().at(-1)!.body)
  expect(prompt).toContain('Which data structure gives')
  await expect(status).toContainText('Interview quiz')

  // Unchanged content is not answered again.
  await main.waitForTimeout(3000)
  await expect(main.getByTestId('response')).toHaveCount(1)

  // Pause: stays in Auto mode, nothing is watched.
  await bar.getByTestId('auto-pause').click()
  await expect(status).toHaveAttribute('data-state', 'paused')
  await expect(bar.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')
  await bar.getByTestId('auto-pause').click()
  await expect(status).not.toHaveAttribute('data-state', 'paused')

  // Manual: only clicks answer.
  await bar.getByRole('radio', { name: 'Manual' }).click()
  await expect(status).toHaveAttribute('data-state', 'manual')
  await main.getByTestId('stop').click()
})
