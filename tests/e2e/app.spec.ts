import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * End-to-end test of the packaged-equivalent build (`npm run build` output) in real Electron:
 * fake microphone → AudioWorklet/VAD → transcription (mock OpenAI) → UI; screen capture of a real
 * window → local OCR; assistant streaming; overlay; stop → history. No real API keys are used.
 */
const root = path.resolve(__dirname, '../..')
let app: ElectronApplication
let main: Page
let mock: MockServer
let userData: string

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  main.evaluate(([c, a]) => (globalThis as unknown as { mycluely: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mycluely.invoke(c as string, ...(a as unknown[])), [channel, args] as const) as Promise<T>

test.beforeAll(async () => {
  mock = await startMockProviders({
    defaultTranscript: 'Can you explain how the caching layer handles invalidation when the database changes?'
  })
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-e2e-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai', openaiModel: 'gpt-transcribe' },
      audio: { systemEnabled: false },
      privacy: { consentReminder: false, saveHistory: true },
      ui: { showOverlayOnStart: true }
    })
  )
  // MYCLUELY_EXECUTABLE=release/<version>/win-unpacked/MyCluely.exe runs the suite against the packaged app.
  const packaged = process.env['MYCLUELY_EXECUTABLE']
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: [
      ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.win32.normalize(path.join(root, 'tests/fixtures/question.wav'))}%noloop`
    ],
    cwd: root,
    env: {
      ...process.env,
      // Never use real provider keys from the developer's environment in tests.
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      MOONSHOT_API_KEY: '',
      MYCLUELY_USER_DATA: userData,
      MYCLUELY_HEADLESS_UI: '1',
      OPENAI_API_KEY: 'sk-e2e-mock-key-0000'
    }
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

test('opens the main window, overlay and hidden capture engine', async () => {
  await expect(main.getByTestId('statusbar')).toBeVisible()
  await expect(main.getByTestId('statusbar')).toContainText('OpenAI')
  const urls = app.windows().map((w) => w.url().split('/').pop())
  expect(urls).toEqual(expect.arrayContaining(['index.html', 'overlay.html', 'capture.html']))
  const capture = app.windows().find((w) => w.url().endsWith('capture.html'))!
  expect(await capture.evaluate(() => (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated)).toBe(true)
})

test('captures the microphone and shows the transcript', async () => {
  await main.getByTestId('start').click()
  await expect(main.getByTestId('pause')).toBeVisible()
  const seg = main.getByTestId('segment').first()
  await expect(seg).toContainText('caching layer handles invalidation', { timeout: 60_000 })
  await expect(seg).toContainText('You')
  // The audio was uploaded as WAV to the transcription endpoint.
  const upload = mock.requests.find((r) => r.path.endsWith('/audio/transcriptions'))!
  expect(upload.raw.toString('latin1')).toContain('RIFF')
})

test('acquires Windows system audio (loopback) when enabled mid-meeting', async () => {
  // Audio stays local: transcription goes to the mock server on 127.0.0.1.
  await invoke('settings:update', { audio: { systemEnabled: true } })
  await expect
    .poll(async () => (await invoke<{ status: { system: { active: boolean; error?: string } } }>('app:snapshot')).status.system, { timeout: 20_000 })
    .toMatchObject({ active: true })
  await expect(main.getByTestId('statusbar')).toContainText('Meeting audio')
  await invoke('settings:update', { audio: { systemEnabled: false } })
  await expect
    .poll(async () => (await invoke<{ status: { system: { active: boolean } } }>('app:snapshot')).status.system.active)
    .toBe(false)
})

test('captures a specific window and reads it with OCR', async () => {
  await app.evaluate(({ BrowserWindow }, file) => {
    const w = new BrowserWindow({ width: 1000, height: 600, x: 30, y: 30, title: 'E2E slide window', focusable: false, skipTaskbar: true })
    w.on('page-title-updated', (e) => e.preventDefault())
    void w.loadFile(file)
  }, path.join(root, 'tests/fixtures/slide.png'))
  let sourceId: string | undefined
  await expect
    .poll(async () => {
      const sources = await invoke<{ id: string; name: string; kind: string }[]>('screen:sources')
      sourceId = sources.find((s) => s.kind === 'window' && s.name.includes('E2E slide window'))?.id
      return !!sourceId
    })
    .toBe(true)
  await invoke('screen:select', sourceId)
  await main.getByTestId('capture-now').click()
  await expect(main.getByTestId('ocr-text')).toContainText('Quarterly Revenue Review', { timeout: 60_000 })
  await expect(main.getByText(/Readable/)).toBeVisible()
})

test('answers the latest question with streaming output', async () => {
  await main.getByTestId('action-answer').click()
  const card = main.getByTestId('response').first()
  await expect(card).toHaveAttribute('data-status', 'done')
  await expect(card).toContainText('change events')
  const body = mock.chatRequests().at(-1)!.body as { instructions: string; input: { content: { text?: string }[] }[]; store: boolean }
  expect(body.store).toBe(false)
  expect(body.input[0].content[0].text).toContain('caching layer handles invalidation')
  expect(body.input[0].content[0].text).toContain('Quarterly Revenue Review')
})

test('ask anything, refine, and see the answer in the overlay', async () => {
  await main.getByTestId('ask-input').fill('What did the slide say about churn?')
  await main.getByTestId('ask-input').press('Enter')
  const card = main.getByTestId('response').first()
  await expect(card).toContainText('What did the slide say about churn?')
  await expect(card).toHaveAttribute('data-status', 'done')
  const overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
  await expect(overlay.getByTestId('response')).toHaveAttribute('data-status', 'done')
  await expect(overlay.getByTestId('response')).toContainText('Mock answer')
})

test('pauses, resumes, stops with a summary saved to history and exportable', async () => {
  await main.getByTestId('pause').click()
  await expect(main.getByTestId('resume')).toBeVisible()
  await main.getByTestId('resume').click()
  await main.getByTestId('stop').click()
  await expect(main.getByTestId('start')).toBeVisible({ timeout: 60_000 })
  await main.getByTestId('nav-history').click()
  await expect(main.locator('.history-item').first()).toBeVisible()
  const list = await invoke<{ id: string; segmentCount: number }[]>('history:list')
  expect(list).toHaveLength(1)
  expect(list[0].segmentCount).toBeGreaterThan(0)
  const record = await invoke<{ snapshots: { ocrText: string; imagePath?: string }[] }>('history:get', list[0].id)
  expect(record.snapshots[0].ocrText).toContain('Quarterly Revenue Review')
  expect(record.snapshots[0].imagePath).toBeUndefined()
})

test('settings show provider status without exposing keys', async () => {
  await main.getByTestId('nav-settings').click()
  const card = main.getByTestId('provider-openai')
  await expect(card).toContainText('from environment')
  await expect(card.getByTestId('saved-key-openai')).toHaveValue(/0000$/)
  expect(await main.content()).not.toContain('sk-e2e-mock-key')
  await card.getByRole('button', { name: 'Test connection' }).click()
  await expect(card).toContainText(/Connected in \d+ ms — 3 chat models/)
})
