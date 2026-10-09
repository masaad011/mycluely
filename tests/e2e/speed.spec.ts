import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockProviders } from '../helpers/mock-providers'

/**
 * Response speed in the real app: answers reuse an open connection even after a pause longer than
 * Node's 4 s default (no new handshake per answer), "Fastest" sends no extended reasoning, and
 * each card shows how long the answer took to start.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('reuses connections between answers and shows how fast each answer started', async () => {
  test.setTimeout(120_000)
  const mock = await startMockProviders()
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-speed-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      audio: { systemEnabled: false, micEnabled: false },
      privacy: { consentReminder: false }
    })
  )
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: 'sk-speed-0000', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('index.html'))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    const ask = async (q: string, n: number): Promise<void> => {
      await main.getByTestId('ask-input').fill(q)
      await main.getByTestId('ask-input').press('Enter')
      await expect(main.getByTestId('response')).toHaveCount(n)
      await expect(main.getByTestId('response').first()).toHaveAttribute('data-status', 'done')
    }

    await ask('What did they ask?', 1)
    // The card shows when the first words arrived.
    await expect(main.getByTestId('response-meta').first()).toContainText(/\d+(\.\d)? s ·/)
    // Fastest (the default) asks for no extended reasoning.
    expect((mock.chatRequests().at(-1)!.body as { reasoning?: unknown }).reasoning).toEqual({ effort: 'none' })

    const before = mock.connections()
    await main.waitForTimeout(6000) // longer than Node's default 4 s keep-alive
    await ask('And the follow-up?', 2)
    expect(mock.connections()).toBe(before)
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
