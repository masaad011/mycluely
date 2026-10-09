import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders, type MockServer } from '../helpers/mock-providers'

/**
 * An API key saved in Settings must survive an app restart (encrypted with Windows DPAPI via
 * Electron safeStorage) and be shown as saved — not as an empty field.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']
let mock: MockServer
let userData: string

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MYCLUELY_USER_DATA: userData,
      MYCLUELY_HEADLESS_UI: '1',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      MOONSHOT_API_KEY: ''
    }
  })
  await app.firstWindow()
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
  const main = app.windows().find((w) => w.url().endsWith('index.html'))!
  await main.waitForLoadState('domcontentloaded')
  return { app, main }
}

test.beforeAll(async () => {
  mock = await startMockProviders()
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-keys-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ ai: { provider: 'anthropic', baseUrls: { anthropic: `${mock.url}/anthropic` } }, privacy: { consentReminder: false } })
  )
})

test.afterAll(async () => {
  await mock?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('a saved API key is remembered after restarting the app', async () => {
  const first = await launch()
  await first.main.getByTestId('nav-settings').click()
  const card = first.main.getByTestId('provider-anthropic')
  await card.getByLabel('Anthropic (Claude) API key').fill('sk-ant-e2e-persist-WXYZ')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(first.main.getByText('Anthropic (Claude) key saved securely.')).toBeVisible()
  await expect(card.getByTestId('saved-key-anthropic')).toHaveValue(/WXYZ$/)
  await expect(card).toContainText('remembered after restart')
  await expect(card).toContainText(/Connected in \d+ ms/)
  await first.app.close()

  const second = await launch()
  await second.main.getByTestId('nav-settings').click()
  const again = second.main.getByTestId('provider-anthropic')
  await expect(again.getByTestId('saved-key-anthropic')).toHaveValue(/WXYZ$/)
  await expect(again).toContainText('key saved')
  // The key itself never reaches the renderer.
  expect(await second.main.content()).not.toContain('sk-ant-e2e-persist')
  // And it is actually usable after the restart.
  await again.getByRole('button', { name: 'Test connection' }).click()
  await expect(again).toContainText(/Connected in \d+ ms — 2 chat models/)
  // Replacing shows an input; cancelling keeps the saved key.
  await again.getByRole('button', { name: 'Replace key' }).click()
  await again.getByRole('button', { name: 'Cancel' }).click()
  await expect(again.getByTestId('saved-key-anthropic')).toHaveValue(/WXYZ$/)
  await second.app.close()
})
