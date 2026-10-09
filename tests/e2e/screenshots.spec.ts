import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders } from '../helpers/mock-providers'

/**
 * Regenerates the screenshots in docs/images from a scripted meeting against the mock provider.
 *   set MYCLUELY_SCREENSHOTS=1 && npx playwright test screenshots
 */
test.skip(process.env['MYCLUELY_SCREENSHOTS'] !== '1', 'set MYCLUELY_SCREENSHOTS=1 to regenerate docs screenshots')

test('documentation screenshots', async () => {
  test.setTimeout(300_000)
  const root = path.resolve(__dirname, '../..')
  // MYCLUELY_SCREENSHOT_DIR / MYCLUELY_SCREENSHOT_THEME allow previews outside docs/ and of either theme.
  const images = process.env['MYCLUELY_SCREENSHOT_DIR'] ?? path.join(root, 'docs/images')
  const theme = process.env['MYCLUELY_SCREENSHOT_THEME'] ?? 'light'
  const lines: [('system' | 'mic'), string][] = [
    ['system', "Thanks for joining. Today we'll review the Q3 numbers and the caching rollout."],
    ['mic', 'Sounds good, I have the dashboard open.'],
    ['system', 'Revenue was up eighteen percent, and churn is down to about two percent.'],
    ['mic', 'The cache hit rate also went from seventy-one to ninety-three percent.'],
    ['system', 'Can you explain how the caching layer handles invalidation when the database changes?']
  ]
  const mock = await startMockProviders({ transcripts: lines.map((l) => l[1]), chunkDelayMs: 2 })
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-shots-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { systemEnabled: false, micEnabled: false },
      assistant: { mode: 'technical' },
      privacy: { consentReminder: false },
      ui: { theme }
    })
  )
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', MYCLUELY_TEST_HOOKS: '1', OPENAI_API_KEY: 'sk-demo-0000', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => ['index.html', 'overlay.html'].every((p) => app.windows().some((w) => w.url().endsWith(p)))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    const overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().endsWith('index.html')) w.setSize(1440, 900)
        if (w.webContents.getURL().endsWith('overlay.html')) w.setSize(420, 600)
      }
    })
    await app.evaluate(({ BrowserWindow }, file) => {
      const w = new BrowserWindow({ width: 1000, height: 600, title: 'Q3 Review — slides', focusable: false, skipTaskbar: true, x: 20, y: 20 })
      w.on('page-title-updated', (e) => e.preventDefault())
      void w.loadFile(file)
    }, path.join(root, 'tests/fixtures/slide.png'))
    const invoke = (c: string, ...a: unknown[]) =>
      main.evaluate(([c, a]) => (globalThis as unknown as { mycluely: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mycluely.invoke(c as string, ...(a as unknown[])), [c, a] as const)
    await main.getByTestId('start').click()
    const wav = Array.from(readFileSync(path.join(root, 'tests/fixtures/question.wav')))
    for (const [i, [source]] of lines.entries()) {
      await app.evaluate(({}, { source, wav, i }) => {
        const t = (globalThis as unknown as { __mycluelyTest: { controller: { meeting: { record: { startedAt: number } }; onAudioSegment: (m: unknown) => void } } }).__mycluelyTest
        t.controller.onAudioSegment({ source, startedAt: t.controller.meeting.record.startedAt + 4000 + i * 9000, durationMs: 5000, peakDb: -12, wav: new Uint8Array(wav) })
      }, { source, wav, i })
      await expect(main.getByTestId('segment')).toHaveCount(i + 1)
    }
    const sources = (await invoke('screen:sources')) as { id: string; name: string }[]
    await invoke('screen:select', sources.find((s) => s.name.includes('Q3 Review'))!.id)
    await main.getByTestId('capture-now').click()
    await expect(main.getByTestId('ocr-text')).toContainText('Quarterly Revenue Review', { timeout: 60_000 })
    await main.getByTestId('action-explain-screen').click()
    await expect(main.getByTestId('response').first()).toHaveAttribute('data-status', 'done')
    await main.getByTestId('action-answer').click()
    await expect(main.getByTestId('response').first()).toHaveAttribute('data-status', 'done')
    await main.getByTestId('action-suggest').click()
    await expect(main.getByTestId('response').first()).toHaveAttribute('data-status', 'done')
    // Auto answer mode, watching the slide window selected above (never the real desktop).
    await main.getByTestId('answer-mode').getByRole('radio', { name: 'Auto' }).click()
    await expect(main.getByTestId('auto-status')).toHaveAttribute('data-state', /nothing|watching/, { timeout: 30_000 })
    await main.waitForTimeout(500)
    await main.screenshot({ path: path.join(images, 'main-window.png') })
    await overlay.screenshot({ path: path.join(images, 'assistant-panel.png') })
    await main.getByTestId('nav-settings').click()
    await main.waitForTimeout(400)
    await main.screenshot({ path: path.join(images, 'settings.png') })
    await main.getByRole('button', { name: 'Appearance' }).click()
    await main.waitForTimeout(300)
    await main.screenshot({ path: path.join(images, 'appearance.png') })
    await main.getByTestId('nav-live').click()
    await main.getByTestId('stop').click()
    await expect(main.getByTestId('start')).toBeVisible({ timeout: 60_000 })
    await main.getByTestId('nav-history').click()
    await main.waitForTimeout(800)
    await main.screenshot({ path: path.join(images, 'history.png') })
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
