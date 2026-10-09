import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders } from '../helpers/mock-providers'

/**
 * DeepSeek end to end against a local mock of its OpenAI-compatible API: save a key, see the live
 * model list, switch provider and get a streamed answer (reasoning text is never shown).
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('saves a DeepSeek key and answers with DeepSeek', async () => {
  test.setTimeout(120_000)
  const mock = await startMockProviders()
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-deepseek-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'anthropic', baseUrls: { deepseek: `${mock.url}/deepseek` } },
      privacy: { consentReminder: false },
      audio: { systemEnabled: false }
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
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      MOONSHOT_API_KEY: '',
      DEEPSEEK_API_KEY: ''
    }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    await main.waitForLoadState('domcontentloaded')
    await main.getByTestId('nav-settings').click()
    const card = main.getByTestId('provider-deepseek')
    await expect(main.getByTestId('subscription-note-deepseek')).toContainText('DeepSeek has no paid subscription')
    await card.getByLabel('DeepSeek API key').fill('sk-ds-e2e-1234')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(main.getByText('DeepSeek key saved securely.')).toBeVisible()
    await expect(card).toContainText(/Connected in \d+ ms — 2 chat models/)

    await main.getByRole('button', { name: 'AI model' }).click()
    await main.getByTestId('provider-select').selectOption('deepseek')
    await expect(main.getByTestId('provider-select')).toHaveValue('deepseek')

    await main.getByTestId('nav-live').click()
    await main.getByTestId('ask-input').fill('What did they ask?')
    await main.getByTestId('ask-input').press('Enter')
    const answer = main.getByTestId('response').first()
    await expect(answer).toHaveAttribute('data-status', 'done')
    await expect(answer).toContainText('Mock answer from the test server.')
    await expect(answer).not.toContainText('internal reasoning')
    const body = mock.chatRequests().at(-1)!.body as Record<string, unknown>
    expect(body).toMatchObject({ model: 'deepseek-flash', stream: true, thinking: { type: 'disabled' } })
    expect(mock.chatRequests().at(-1)!.headers.authorization).toBe('Bearer sk-ds-e2e-1234')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
