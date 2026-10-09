import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startChatGPTMock } from '../helpers/mock-chatgpt'

/**
 * "Continue with ChatGPT" end to end against a local mock of OpenAI's sign-in and plan-usage API.
 * The test hook replaces the system browser with a request that approves the sign-in.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('connects a ChatGPT plan and answers with it', async () => {
  test.setTimeout(120_000)
  const mock = await startChatGPTMock()
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-siwc-'))
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ privacy: { consentReminder: false }, audio: { systemEnabled: false } }))
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MYCLUELY_USER_DATA: userData,
      MYCLUELY_HEADLESS_UI: '1',
      MYCLUELY_TEST_HOOKS: '1',
      MYCLUELY_CHATGPT_ISSUER: mock.url,
      MYCLUELY_CHATGPT_RESOURCE: `${mock.url}/v1`,
      MYCLUELY_CHATGPT_PORT: '0',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      MOONSHOT_API_KEY: ''
    }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    await main.waitForLoadState('domcontentloaded')
    await main.getByTestId('nav-settings').click()
    const card = main.getByTestId('provider-chatgpt')
    await expect(card).toContainText('not connected')
    // Other providers explain why their subscriptions can't be used.
    await expect(main.getByTestId('subscription-note-anthropic')).toContainText('Claude Pro/Max subscriptions can’t be used here')
    await expect(main.getByTestId('subscription-note-gemini')).toContainText('free-tier key works')

    await card.getByRole('button', { name: 'Continue with ChatGPT' }).click()
    await expect(card.getByTestId('chatgpt-account')).toHaveValue('Signed in as sam@example.com')
    await expect(card).toContainText('connected')
    await expect(card).toContainText(/Connected in \d+ ms — 2 chat models available with your ChatGPT plan/)
    expect(mock.authorizeRequests[0].get('agent_name_hint')).toBe('MyCluely')

    // The selected provider (Anthropic) has no key, so connecting switches answers to the plan.
    await expect(card).toContainText('active')
    await expect(main.getByText('Answers now use your ChatGPT plan.')).toBeVisible()
    await main.getByTestId('nav-live').click()
    await main.getByTestId('ask-input').fill('What did they ask?')
    await main.getByTestId('ask-input').press('Enter')
    const answer = main.getByTestId('response').first()
    await expect(answer).toHaveAttribute('data-status', 'done')
    await expect(answer).toContainText('Answered with your ChatGPT plan.')
    expect(mock.responsesBodies.at(-1)).toMatchObject({ store: false, stream: true, model: 'gpt-6.1-sol' })

    // Sign out revokes the session.
    await main.getByTestId('nav-settings').click()
    await card.getByRole('button', { name: 'Sign out' }).click()
    await expect(card).toContainText('not connected')
    expect(mock.revoked).toHaveLength(1)
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
