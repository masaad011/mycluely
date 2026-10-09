import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * Panels: the Live view's Transcript, Screen and Assistant panels collapse (a column whose panels
 * are all collapsed becomes a rail), expand to fill the view, and resize with drag handles (mouse,
 * keyboard, double-click to reset); the History list resizes; the floating panel collapses to its
 * title bar. The layout is saved with the settings.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']
let app: ElectronApplication
let main: Page
let overlay: Page
let mock: MockServer
let userData: string

const layout = () =>
  main.evaluate(() =>
    (globalThis as unknown as { mycluely: { invoke: (c: string) => Promise<{ ui: { layout: Record<string, unknown> } }> } }).mycluely
      .invoke('settings:get')
      .then((s) => s.ui.layout)
  )
const width = async (testId: string) => (await main.getByTestId(testId).boundingBox())?.width ?? 0
const overlayBounds = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('overlay.html'))!
    return { height: w.getBounds().height, resizable: w.isResizable() }
  })

test.beforeAll(async () => {
  mock = await startMockProviders()
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-panels-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ ai: { provider: 'openai', baseUrls: { openai: `${mock.url}/openai/v1` } }, audio: { micEnabled: false, systemEnabled: false }, privacy: { consentReminder: false } })
  )
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: 'sk-panels', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  await app.firstWindow()
  await expect.poll(() => ['index.html', 'overlay.html'].every((p) => app.windows().some((w) => w.url().endsWith(p)))).toBe(true)
  main = app.windows().find((w) => w.url().endsWith('index.html'))!
  overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('index.html')) w.setSize(1440, 900)
  })
  await expect(main.getByTestId('panel-assistant')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await mock?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('panels collapse to their header, and a fully collapsed column becomes a rail', async () => {
  await main.getByTestId('collapse-screen').click()
  await expect(main.getByTestId('collapse-screen')).toHaveAttribute('aria-expanded', 'false')
  await expect(main.locator('.screen-body')).toHaveCount(0)
  await expect(main.getByTestId('panel-screen').getByTestId('capture-now')).toBeVisible() // controls stay usable

  await main.getByTestId('collapse-transcript').click()
  await expect(main.getByTestId('rail-transcript')).toBeVisible()
  await expect(main.getByTestId('rail-screen')).toBeVisible()
  await expect(main.getByTestId('panel-transcript')).toHaveCount(0)
  expect(await width('panel-assistant')).toBeGreaterThan(1250)

  await main.getByTestId('rail-transcript').click()
  await expect(main.getByTestId('panel-transcript')).toBeVisible()
  await expect(main.locator('.transcript')).toBeVisible()
  await main.getByTestId('collapse-screen').click()
  await expect(main.locator('.screen-body')).toBeVisible()

  // The Assistant column collapses sideways.
  await main.getByTestId('collapse-assistant').click()
  await expect(main.getByTestId('rail-assistant')).toBeVisible()
  await expect(main.getByTestId('panel-assistant')).toHaveCount(0)
  await main.getByTestId('rail-assistant').click()
  await expect(main.getByTestId('panel-assistant')).toBeVisible()
  expect(await layout()).toMatchObject({ collapsed: { transcript: false, screen: false, assistant: false }, maximized: null })
})

test('a panel expands to fill the view and Esc restores the layout', async () => {
  await main.getByTestId('expand-assistant').click()
  await expect(main.getByTestId('panel-transcript')).toHaveCount(0)
  await expect(main.getByTestId('panel-screen')).toHaveCount(0)
  expect(await width('panel-assistant')).toBeGreaterThan(1300)
  await main.keyboard.press('Escape')
  await expect(main.getByTestId('panel-transcript')).toBeVisible()

  await main.getByTestId('expand-screen').click()
  await expect(main.getByTestId('panel-assistant')).toHaveCount(0)
  await expect(main.getByTestId('panel-transcript')).toHaveCount(0)
  await main.getByTestId('expand-screen').click() // the same button restores
  await expect(main.getByTestId('panel-assistant')).toBeVisible()
})

test('drag handles resize the panels, with keyboard support and double-click to reset', async () => {
  const handle = main.getByRole('separator', { name: 'Resize panels' })
  const before = await width('panel-assistant')
  const box = (await handle.boundingBox())!
  await main.mouse.move(box.x + box.width / 2, box.y + 200)
  await main.mouse.down()
  await main.mouse.move(box.x + 200, box.y + 200, { steps: 6 })
  await main.mouse.up()
  await expect.poll(async () => (await layout()).leftWidth as number).toBeGreaterThan(0.6)
  expect(await width('panel-assistant')).toBeLessThan(before - 150)

  await handle.dblclick()
  await expect.poll(async () => (await layout()).leftWidth).toBe(0.49)

  // Keyboard: the Transcript/Screen handle moves in 2% steps.
  const rows = main.getByRole('separator', { name: 'Resize Transcript and Screen' })
  await rows.focus()
  await main.keyboard.press('ArrowDown')
  await main.keyboard.press('ArrowDown')
  await expect.poll(async () => Math.round(((await layout()).transcriptHeight as number) * 100)).toBe(64)

  // History: the meeting list resizes too.
  await main.getByTestId('nav-history').click()
  const list = main.getByRole('separator', { name: 'Resize the meeting list' })
  await list.focus()
  await main.keyboard.press('ArrowRight')
  await expect.poll(async () => (await layout()).historyWidth).toBe(336)
  await main.getByTestId('nav-live').click()
})

test('the floating panel collapses to its title bar and flags new answers', async () => {
  const full = await overlayBounds()
  await overlay.getByTestId('overlay-collapse').click()
  await expect.poll(async () => (await overlayBounds()).height).toBeLessThan(80)
  expect((await overlayBounds()).resizable).toBe(false)
  await expect(overlay.getByTestId('ask-input')).toHaveCount(0)

  // An answer arriving while collapsed is flagged; clicking the flag expands the panel.
  await main.getByTestId('ask-input').fill('What did they ask?')
  await main.getByTestId('ask-input').press('Enter')
  await expect(overlay.getByTestId('new-answer')).toBeVisible()
  await overlay.getByTestId('new-answer').click()
  await expect.poll(async () => (await overlayBounds()).height).toBe(full.height)
  expect((await overlayBounds()).resizable).toBe(true)
  await expect(overlay.getByTestId('response').first()).toBeVisible()
})
