import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Settings → Audio capture: choosing the microphone (Windows default, a specific device, or a saved
 * one that is no longer connected), testing it with a level meter, and what system audio records.
 * Chromium's fake devices play a speech file, so no real microphone is ever opened.
 */
const root = path.resolve(__dirname, '../..')
let app: ElectronApplication
let main: Page
let userData: string

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  main.evaluate(([c, a]) => (globalThis as unknown as { mycluely: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mycluely.invoke(c as string, ...(a as unknown[])), [channel, args] as const) as Promise<T>

test.beforeAll(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-e2e-audio-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    // System audio off: the meeting below must never record this PC's real playback.
    JSON.stringify({
      audio: { micDeviceId: 'a-headset-that-is-unplugged', systemEnabled: false },
      assistant: { autoScreen: false },
      privacy: { consentReminder: false, saveHistory: false }
    })
  )
  const packaged = process.env['MYCLUELY_EXECUTABLE']
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: [
      ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.win32.normalize(path.join(root, 'tests/fixtures/question.wav'))}`
    ],
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      MOONSHOT_API_KEY: '',
      OPENAI_API_KEY: '',
      MYCLUELY_USER_DATA: userData,
      MYCLUELY_HEADLESS_UI: '1'
    }
  })
  await app.firstWindow()
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
  main = app.windows().find((w) => w.url().endsWith('index.html'))!
  await main.waitForLoadState('domcontentloaded')
  await main.evaluate(() => {
    const w = globalThis as unknown as { mycluely: { on: (e: string, cb: (p: unknown) => void) => void }; __micTests: { active: boolean; level: number }[] }
    w.__micTests = []
    w.mycluely.on('mic-test', (m) => w.__micTests.push(m as { active: boolean; level: number }))
  })
  await main.getByTestId('nav-settings').click()
  await main.getByRole('button', { name: 'Audio capture' }).click()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('lists the microphones and flags a saved one that is no longer connected', async () => {
  const select = main.getByTestId('mic-device')
  await expect(main.getByLabel('Input device')).toBeVisible()
  // The saved device is kept (not silently shown as another microphone) and explained.
  await expect(select.locator('option:checked')).toHaveText('Previously selected microphone (not connected)')
  await expect(main.getByTestId('mic-missing')).toBeVisible()
  const options = await select.locator('option').allTextContents()
  expect(options[0]).toMatch(process.platform === 'win32' ? /^Windows default/ : /^System default/)
  expect(options.length).toBeGreaterThanOrEqual(3) // default, at least one microphone, the missing one
  // No playback device is offered as a microphone, and the aliases are not repeated as devices.
  expect(options.slice(1).some((o) => /^(Default|Communications) - /.test(o))).toBe(false)

  const device = await select.locator('option').nth(options.length - 2).getAttribute('value')
  await select.selectOption(device!)
  await expect(main.getByTestId('mic-missing')).toBeHidden()
  await expect.poll(async () => (await invoke<{ audio: { micDeviceId: string } }>('settings:get')).audio.micDeviceId).toBe(device)
  await select.selectOption('default')
  await expect.poll(async () => (await invoke<{ audio: { micDeviceId: string } }>('settings:get')).audio.micDeviceId).toBe('default')
})

test('tests the selected microphone with a moving level meter', async () => {
  await main.getByTestId('mic-test').click()
  const status = main.getByTestId('mic-test-status')
  await expect(status).toBeVisible()
  await expect(main.getByTestId('mic-test')).toHaveText('Stop test')
  const bar = status.locator('.level-bar')
  await expect.poll(async () => Number(await bar.getAttribute('data-level')), { timeout: 15_000 }).toBeGreaterThan(0.1)
  await expect(status).toContainText(/Hearing you on|Say something/)

  await main.getByTestId('mic-test').click()
  await expect(main.getByTestId('mic-test')).toHaveText('Test')
  await expect(status).toBeHidden()
  await expect.poll(() => main.evaluate(() => (globalThis as unknown as { __micTests: { active: boolean }[] }).__micTests.at(-1)?.active)).toBe(false)
})

test('stops the microphone test when leaving Settings', async () => {
  await main.getByTestId('mic-test').click()
  await expect.poll(() => main.evaluate(() => (globalThis as unknown as { __micTests: { active: boolean }[] }).__micTests.at(-1)?.active)).toBe(true)
  await main.getByTestId('nav-live').click()
  await expect.poll(() => main.evaluate(() => (globalThis as unknown as { __micTests: { active: boolean }[] }).__micTests.at(-1)?.active)).toBe(false)
  await main.getByTestId('nav-settings').click()
  await main.getByRole('button', { name: 'Audio capture' }).click()
})

test('shows which playback device system audio records', async () => {
  test.skip(process.platform !== 'win32', 'Windows loopback only')
  await expect(main.getByTestId('system-audio-device')).toContainText('Records:')
  await expect(main.getByTestId('open-sound-settings')).toBeVisible() // not clicked: it opens the real Windows Settings app
})

test('refuses a microphone test while a meeting is running', async () => {
  await invoke('session:start', { title: 'Mic test guard' })
  await expect.poll(async () => (await invoke<{ status: { session: string } }>('app:snapshot')).status.session).not.toBe('idle')
  await expect(main.getByTestId('mic-test')).toBeDisabled()
  const err = await invoke('audio:test-mic', true, 'default').then(
    () => '',
    (e: Error) => e.message
  )
  expect(err).toContain('Stop the meeting')
  await invoke('session:stop')
})
