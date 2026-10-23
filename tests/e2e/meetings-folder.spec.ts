import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Settings → Privacy & data → Meetings folder: picking a folder moves the saved meetings there,
 * History reads them from it, and the choice survives a restart and "Reset all settings".
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']
let userData: string
let chosen: string
const id = '2026-10-01_e2efolder'

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

async function openPrivacy(main: Page): Promise<void> {
  await main.getByTestId('nav-settings').click()
  await main.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Privacy & data' }).click()
}

test.beforeAll(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'mycluely-folder-'))
  chosen = path.join(userData, 'project', 'meetings')
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ privacy: { consentReminder: false } }))
  const dir = path.join(userData, 'meetings', id)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    path.join(dir, 'meeting.json'),
    JSON.stringify({ id, title: 'Folder move check', mode: 'general', startedAt: now, endedAt: now + 60_000, durationMs: 60_000, responses: [], questions: [], snapshots: [] })
  )
  writeFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ id: 's1', source: 'mic', speaker: 'You', text: 'hello from the old folder', startMs: 0, endMs: 1000, at: Date.now(), status: 'ok' }) + '\n')
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('moves saved meetings to the chosen folder and keeps using it', async () => {
  const first = await launch()
  // The native folder picker cannot be driven; answer it with the chosen folder.
  await first.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
  }, chosen)
  await openPrivacy(first.main)
  await expect(first.main.getByTestId('meetings-folder')).toHaveValue(/Default/)
  await first.main.getByRole('button', { name: 'Change…' }).click()
  await expect(first.main.getByText('Meetings folder changed — moved 1 meeting.')).toBeVisible()
  await expect(first.main.getByTestId('meetings-folder')).toHaveValue(chosen)
  expect(existsSync(path.join(chosen, id, 'transcript.jsonl'))).toBe(true)
  expect(existsSync(path.join(userData, 'meetings'))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).privacy.meetingsDir).toBe(chosen)

  // Resetting settings keeps the folder (it would otherwise hide the meetings).
  await first.main.getByRole('button', { name: 'Reset all settings' }).click()
  await openPrivacy(first.main)
  await expect(first.main.getByTestId('meetings-folder')).toHaveValue(chosen)
  await first.app.close()

  const second = await launch()
  await second.main.getByTestId('nav-history').click()
  await second.main.getByRole('button', { name: /Folder move check/ }).click()
  await second.main.getByRole('button', { name: 'Transcript (1)' }).click()
  await expect(second.main.getByText('hello from the old folder')).toBeVisible()
  await openPrivacy(second.main)
  await second.main.getByRole('button', { name: 'Use default' }).click()
  await expect(second.main.getByText('Meetings folder changed — moved 1 meeting.')).toBeVisible()
  await expect(second.main.getByTestId('meetings-folder')).toHaveValue(/Default/)
  expect(existsSync(path.join(userData, 'meetings', id, 'meeting.json'))).toBe(true)
  await second.app.close()
})
