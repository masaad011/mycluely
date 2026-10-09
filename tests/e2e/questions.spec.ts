import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promptText, startMockProviders } from '../helpers/mock-providers'

/**
 * "Questions to ask": questions for the user to ask, based on the conversation, each copyable;
 * "More questions" asks for new ones without repeating earlier suggestions.
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('suggests questions to ask from the conversation, copyable one by one', async () => {
  test.setTimeout(120_000)
  const mock = await startMockProviders({ transcripts: ['We plan to migrate billing to Postgres in November and invalidate the cache with change events.'] })
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-questions-'))
  writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' }, baseUrls: { openai: `${mock.url}/openai/v1` } },
      transcription: { engine: 'openai' },
      audio: { systemEnabled: false, micEnabled: false },
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
      OPENAI_API_KEY: 'sk-questions-0000',
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
    await main.getByTestId('start').click()
    const wav = Array.from(readFileSync(path.join(root, 'tests/fixtures/question.wav')))
    await app.evaluate(({}, wav) => {
      const t = (globalThis as unknown as { __mycluelyTest: { controller: { meeting: { record: { startedAt: number } }; onAudioSegment: (m: unknown) => void } } }).__mycluelyTest
      t.controller.onAudioSegment({ source: 'system', startedAt: t.controller.meeting.record.startedAt + 2000, durationMs: 4000, peakDb: -10, wav: new Uint8Array(wav) })
    }, wav)
    await expect(main.getByTestId('segment')).toHaveCount(1)

    const button = main.getByTestId('action-suggest')
    await expect(button).toContainText('Questions to ask')
    await button.click()
    const card = main.getByTestId('response').first()
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(card).toContainText('Questions to ask')
    const items = card.getByTestId('suggestion')
    await expect(items).toHaveCount(3)
    await expect(items.nth(1)).toContainText('Who owns the Postgres migration?')
    await expect(items.nth(1)).toContainText('ownership')
    // The request is grounded in the conversation.
    expect(promptText(mock.chatRequests().at(-1)!.body)).toContain('migrate billing to Postgres')

    // Copy one question (with test hooks, copies go to a list, never to the real clipboard).
    await items.nth(1).getByRole('button', { name: 'Copy question 2' }).click()
    const copied = () => app.evaluate(() => (globalThis as unknown as { __mycluelyTest: { clipboard: string[] } }).__mycluelyTest.clipboard.slice())
    await expect.poll(copied).toEqual(['Who owns the Postgres migration?'])
    await card.getByRole('button', { name: 'Copy all' }).click()
    await expect.poll(async () => (await copied()).at(-1)).toBe('What is the cache TTL?\nWho owns the Postgres migration?\nWhat is the rollback plan?')

    // The floating panel shows the same list.
    await expect(overlay.getByTestId('suggestion')).toHaveCount(3)

    // More questions: a new card, and the model is told what was already suggested.
    await card.getByTestId('more-questions').click()
    await expect(main.getByTestId('response')).toHaveCount(2)
    await expect(main.getByTestId('response').first()).toHaveAttribute('data-status', 'done')
    const prompt = promptText(mock.chatRequests().at(-1)!.body)
    expect(prompt).toContain('<already_suggested_questions>')
    expect(prompt).toContain('- Who owns the Postgres migration?')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
