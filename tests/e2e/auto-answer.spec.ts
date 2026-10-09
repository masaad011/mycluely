import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders } from '../helpers/mock-providers'

/**
 * The Auto-answer switch: off, a remote question is only highlighted; on, it is answered without
 * clicking Answer. The switch in the main window and the floating panel stay in sync.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('answers remote questions automatically when Auto-answer is on', async () => {
  test.setTimeout(120_000)
  const mock = await startMockProviders({
    transcripts: ['What is the rollback plan for the Postgres migration?', 'And who owns the cache invalidation work?']
  })
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-auto-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { systemEnabled: false, micEnabled: false },
      // Spoken questions only: screen watching stays off, so the test never reads the desktop.
      assistant: { autoSuggest: 'questions', suggestionCooldownSec: 5, autoScreen: false },
      privacy: { consentReminder: false }
    })
  )
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MYCLUELY_USER_DATA: userData,
      MYCLUELY_HEADLESS_UI: '1',
      MYCLUELY_TEST_HOOKS: '1',
      OPENAI_API_KEY: 'sk-auto-0000',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: ''
    }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => ['index.html', 'overlay.html'].every((p) => app.windows().some((w) => w.url().endsWith(p)))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    const overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
    const wav = Array.from(readFileSync(path.join(root, 'tests/fixtures/question.wav')))
    // Remote speech, injected as if it came from Windows system audio.
    const remoteSays = (i: number) =>
      app.evaluate(({}, { wav, i }) => {
        const t = (globalThis as unknown as { __mycluelyTest: { controller: { meeting: { record: { startedAt: number } }; onAudioSegment: (m: unknown) => void } } }).__mycluelyTest
        t.controller.onAudioSegment({ source: 'system', startedAt: t.controller.meeting.record.startedAt + 2000 + i * 8000, durationMs: 4000, peakDb: -10, wav: new Uint8Array(wav) })
      }, { wav, i })

    const auto = main.getByTestId('answer-mode').getByRole('radio', { name: 'Auto' })
    const panelAuto = overlay.getByTestId('answer-mode').getByRole('radio', { name: 'Auto' })
    await expect(auto).toHaveAttribute('aria-checked', 'false')
    await main.getByTestId('start').click()

    // Manual: the question is highlighted with an Answer chip, nothing is answered.
    await remoteSays(0)
    await expect(main.getByTestId('questions')).toContainText('What is the rollback plan')
    await main.waitForTimeout(1500)
    await expect(main.getByTestId('response')).toHaveCount(0)

    // Switch to Auto: the open question is answered straight away, and the panel follows.
    await auto.click()
    await expect(auto).toHaveAttribute('aria-checked', 'true')
    await expect(panelAuto).toHaveAttribute('aria-checked', 'true')
    await expect(main.getByTestId('action-answer')).toContainText('Automatic')
    const first = main.getByTestId('response').first()
    await expect(first).toHaveAttribute('data-status', 'done')
    await expect(first).toContainText('auto')
    await expect(first).toContainText('rollback plan')

    // The next question is answered without any click.
    await remoteSays(1)
    await expect(main.getByTestId('response')).toHaveCount(2, { timeout: 20_000 })
    await expect(main.getByTestId('response').first()).toContainText('who owns the cache invalidation work')

    // Switching to Manual from the panel returns to answering on click.
    await overlay.getByTestId('answer-mode').getByRole('radio', { name: 'Manual' }).click()
    await expect(auto).toHaveAttribute('aria-checked', 'false')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
