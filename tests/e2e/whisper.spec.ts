import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Real on-device transcription (no mocks, no keys): Whisper via transformers.js in the capture
 * engine. Opt-in because the first run downloads the model (~100–200 MB) from Hugging Face:
 *   set MYCLUELY_E2E_WHISPER=1 && npx playwright test whisper
 */
test.skip(process.env['MYCLUELY_E2E_WHISPER'] !== '1', 'set MYCLUELY_E2E_WHISPER=1 to run')

test('transcribes speech on-device with Whisper', async () => {
  test.setTimeout(600_000)
  const root = path.resolve(__dirname, '../..')
  const userData = process.env['MYCLUELY_E2E_PROFILE'] ?? mkdtempSync(path.join(tmpdir(), 'mycluely-whisper-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      transcription: { engine: 'local', localModel: 'onnx-community/whisper-base.en' },
      audio: { systemEnabled: false },
      privacy: { consentReminder: false, saveHistory: false }
    })
  )
  const app = await electron.launch({
    args: [
      path.join(root, 'out/main/index.js'),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.win32.normalize(path.join(root, 'tests/fixtures/question.wav'))}%noloop`
    ],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    await main.getByTestId('start').click()
    await expect(main.getByTestId('segment').first()).toContainText(/caching layer handles invalidation/i, { timeout: 540_000 })
    await expect(main.getByTestId('statusbar')).toContainText(/On-device Whisper ready \((webgpu|wasm)\)/)
  } finally {
    await app.close()
    if (!process.env['MYCLUELY_E2E_PROFILE']) rmSync(userData, { recursive: true, force: true })
  }
})
