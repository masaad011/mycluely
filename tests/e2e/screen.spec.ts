import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * Screen reading in the real app: light-on-dark text (dark themes) and automatic capture
 * noticing a new slide that has the same layout as the previous one.
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
      ;(globalThis as unknown as Record<string, unknown>)[`win_${title}`] = w
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
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-screen-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { systemEnabled: false },
      privacy: { consentReminder: false }
    })
  )
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: [
      ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.win32.normalize(path.join(root, 'tests/fixtures/question.wav'))}%noloop`
    ],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: 'sk-screen-test', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  await app.firstWindow()
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
  main = app.windows().find((w) => w.url().endsWith('index.html'))!
  await main.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await mock?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('reads light-on-dark text (dark theme editor) as readable', async () => {
  await invoke('screen:select', await showImageWindow('Dark code', 'dark-code.html'))
  await main.getByTestId('capture-now').click()
  await expect(main.getByTestId('ocr-text')).toContainText('invalidateCache', { timeout: 60_000 })
  await expect(main.getByTestId('ocr-text')).toContainText('resolveKeys')
  await expect(main.getByText(/^Readable/)).toBeVisible()
})

test('automatic capture picks up the next slide even when the layout is the same', async () => {
  await invoke('screen:select', await showImageWindow('Deck', 'slide.png'))
  await invoke('settings:update', { screen: { autoCapture: true, intervalSec: 3, skipUnchanged: true } })
  await invoke('screen:auto', true, 3)
  await main.getByTestId('start').click()
  await expect(main.getByTestId('ocr-text')).toContainText('Quarterly Revenue Review', { timeout: 60_000 })
  // Next slide: same template, different text.
  await app.evaluate(({}, file) => {
    const w = (globalThis as unknown as Record<string, Electron.BrowserWindow>)['win_Deck']
    void w.loadFile(file)
  }, path.join(root, 'tests/fixtures/slide-2.png'))
  await expect(main.getByTestId('ocr-text')).toContainText('Quarterly Hiring Overview', { timeout: 30_000 })
  const snap = await invoke<{ snapshots: { trigger: string; ocrText: string }[] }>('app:snapshot')
  expect(snap.snapshots.filter((s) => s.trigger === 'auto').length).toBeGreaterThanOrEqual(2)
  await main.getByTestId('stop').click()
})
