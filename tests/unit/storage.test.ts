import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { meetingToMarkdown, meetingToText } from '@shared/export'
import type { MeetingRecord, ScreenSnapshot, TranscriptSegment } from '@shared/types'
import { CredentialStore, type Encryptor } from '../../src/main/services/credential-store'
import { MeetingStore } from '../../src/main/services/meeting-store'
import { sanitizeSettings } from '../../src/main/services/settings-schema'
import { SettingsStore } from '../../src/main/services/settings-store'

/** Reversible stand-in for DPAPI that still keeps plaintext off disk. */
const fakeEncryptor: Encryptor = {
  isAvailable: async () => true,
  encrypt: async (s) => Buffer.from(`enc:${Buffer.from(s).reverse().toString('hex')}`),
  decrypt: async (b) => ({ value: Buffer.from(b.toString().slice(4), 'hex').reverse().toString(), shouldReEncrypt: false })
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycluely-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('settings', () => {
  it('fills defaults and repairs invalid values', () => {
    const s = sanitizeSettings({
      ai: { provider: 'nope', maxContextTokens: -5, models: { openai: 'gpt-6-luna' } },
      audio: { vadSensitivity: 7 },
      shortcuts: { answer: 'Alt+A' },
      bogus: true
    })
    expect(s.ai.provider).toBe(DEFAULT_SETTINGS.ai.provider)
    expect(s.ai.maxContextTokens).toBe(DEFAULT_SETTINGS.ai.maxContextTokens)
    expect(s.ai.models.openai).toBe('gpt-6-luna')
    expect(s.ai.models.anthropic).toBe(DEFAULT_SETTINGS.ai.models.anthropic)
    expect(s.audio.vadSensitivity).toBe(DEFAULT_SETTINGS.audio.vadSensitivity)
    expect(s.shortcuts.answer).toBe('Alt+A')
    expect(s.shortcuts.summarize).toBe(DEFAULT_SETTINGS.shortcuts.summarize)
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })

  it('follows the Windows theme by default and keeps an explicit choice', () => {
    expect(sanitizeSettings({}).ui.theme).toBe('system')
    expect(sanitizeSettings({ ui: { theme: 'light', fontScale: 1.2 } }).ui).toMatchObject({ theme: 'light', fontScale: 1.2 })
    expect(sanitizeSettings({ ui: { theme: 'sepia' } }).ui.theme).toBe('system')
  })

  it('migrates version-1 settings to the new screenshot policy without overriding explicit choices', () => {
    expect(sanitizeSettings({ version: 1, ai: { imagePolicy: 'explain' } }).ai.imagePolicy).toBe('auto')
    expect(sanitizeSettings({ version: 1, ai: { imagePolicy: 'never' } }).ai.imagePolicy).toBe('never')
    expect(sanitizeSettings({ version: 2, ai: { imagePolicy: 'explain' } }).ai.imagePolicy).toBe('explain')
    expect(sanitizeSettings({}).version).toBe(4)
  })

  it('hides MyCluely from screen sharing by default, and turns it on once for older profiles', () => {
    expect(sanitizeSettings({}).privacy.hideFromCapture).toBe(true)
    // An older profile that still had it off (the previous default) is switched on by the v4 migration.
    expect(sanitizeSettings({ version: 3, privacy: { hideFromCapture: false } }).privacy.hideFromCapture).toBe(true)
    // A current profile's explicit choice is kept.
    expect(sanitizeSettings({ version: 4, privacy: { hideFromCapture: false } }).privacy.hideFromCapture).toBe(false)
  })

  it('moves the old 30 s auto-answer cooldown to the new default but keeps other choices', () => {
    expect(sanitizeSettings({ version: 2, assistant: { suggestionCooldownSec: 30 } }).assistant.suggestionCooldownSec).toBe(10)
    expect(sanitizeSettings({ version: 2, assistant: { suggestionCooldownSec: 60 } }).assistant.suggestionCooldownSec).toBe(60)
    expect(sanitizeSettings({ version: 3, assistant: { suggestionCooldownSec: 30 } }).assistant.suggestionCooldownSec).toBe(30)
  })

  it('persists updates and survives a corrupt file', async () => {
    const store = await SettingsStore.open(dir)
    await store.update({ assistant: { style: 'technical' }, ai: { baseUrls: { openai: 'http://localhost:1234/v1' } } })
    const reopened = await SettingsStore.open(dir)
    expect(reopened.get().assistant.style).toBe('technical')
    expect(reopened.get().ai.baseUrls.openai).toBe('http://localhost:1234/v1')
    await reopened.update({ ai: { baseUrls: {} } })
    expect(reopened.get().ai.baseUrls.openai).toBeUndefined()
    await writeFile(path.join(dir, 'settings.json'), '{ not json')
    expect((await SettingsStore.open(dir)).get().assistant.style).toBe(DEFAULT_SETTINGS.assistant.style)
  })
})

describe('credential store', () => {
  it('encrypts keys at rest and only exposes a hint', async () => {
    const store = new CredentialStore(dir, fakeEncryptor, {})
    await store.set('openai', 'sk-test-1234567890abcd')
    const file = await readFile(path.join(dir, 'credentials.json'), 'utf8')
    expect(file).not.toContain('sk-test-1234567890abcd')
    const reopened = new CredentialStore(dir, fakeEncryptor, {})
    expect(await reopened.get('openai')).toBe('sk-test-1234567890abcd')
    const status = await reopened.status()
    expect(status.openai).toEqual({ configured: true, source: 'stored', hint: 'abcd' })
    expect(status.anthropic.configured).toBe(false)
    await reopened.clear('openai')
    expect(await reopened.get('openai')).toBeUndefined()
  })

  it('reports a saved key that can no longer be decrypted instead of silently dropping it', async () => {
    await writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ anthropic: Buffer.from('garbage').toString('base64') }))
    const failing: Encryptor = { ...fakeEncryptor, decrypt: async () => { throw new Error('Decryption failed') } }
    const status = await new CredentialStore(dir, failing, {}).status()
    expect(status.anthropic.configured).toBe(false)
    expect(status.anthropic.source).toBe('stored')
    expect(status.anthropic.problem).toMatch(/could not be decrypted/)
  })

  it('falls back to environment variables and refuses without OS encryption', async () => {
    const store = new CredentialStore(dir, { ...fakeEncryptor, isAvailable: async () => false }, { GEMINI_API_KEY: 'AIza-env-key-wxyz' })
    expect(await store.get('gemini')).toBe('AIza-env-key-wxyz')
    expect((await store.status()).gemini).toEqual({ configured: true, source: 'env', hint: 'wxyz' })
    await expect(store.set('openai', 'sk-abc')).rejects.toThrow(/not available/)
    await expect(store.set('openai', 'has spaces')).rejects.toThrow()
  })
})

function record(id: string, startedAt: number): MeetingRecord {
  return {
    id,
    title: 'Design review',
    mode: 'technical',
    startedAt,
    endedAt: startedAt + 600_000,
    durationMs: 600_000,
    segmentCount: 0,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    hasSummary: true,
    segments: [],
    responses: [
      { id: 'r1', action: 'answer', text: 'Use change events.', status: 'done', provider: 'anthropic', model: 'claude-opus-5-5', style: 'short', at: startedAt + 60_000 }
    ],
    questions: [{ id: 'q1', segmentId: 's1', text: 'How is the cache invalidated?', speaker: 'Remote', at: startedAt, score: 0.9, status: 'answered' }],
    snapshots: [],
    summary: {
      overview: 'Reviewed caching.',
      keyPoints: ['Cache hit rate 93%'],
      decisions: ['Use change events'],
      actionItems: ['Sam — migrate billing — November'],
      openQuestions: [],
      updatedAt: startedAt,
      markdown: ''
    }
  }
}

const seg = (id: string, text: string, startMs: number): TranscriptSegment => ({
  id,
  source: 'system',
  speaker: 'Remote',
  text,
  startMs,
  endMs: startMs + 2000,
  at: startMs,
  status: 'ok'
})

describe('meeting store', () => {
  it('saves, appends transcript lines, lists, exports and applies retention', async () => {
    const store = new MeetingStore(path.join(dir, 'meetings'))
    const now = Date.now()
    const m = record('2026-10-01_abc', now - 2 * 86_400_000)
    await store.save(m)
    await store.appendSegment(m.id, seg('s2', 'second', 5000))
    await store.appendSegment(m.id, seg('s1', 'first', 1000))
    await store.appendSegment(m.id, { ...seg('s1', 'first (corrected)', 1000) })
    // A torn final line (crash mid-write) must not break loading.
    await appendFile(path.join(dir, 'meetings', m.id, 'transcript.jsonl'), '{"id":"broken",')

    const loaded = await store.get(m.id)
    expect(loaded?.segments.map((s) => s.text)).toEqual(['first (corrected)', 'second'])
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: m.id, title: 'Design review', hasSummary: true })

    const md = meetingToMarkdown(loaded!)
    expect(md).toContain('# Design review')
    expect(md).toContain('- [ ] Sam — migrate billing — November')
    expect(md).toContain('**[00:01] Remote:** first (corrected)')
    expect(md).toContain('Use change events.')
    expect(meetingToText(loaded!)).toContain('ACTION ITEMS')

    await store.save(record('2026-01-01_old', now - 100 * 86_400_000))
    expect(await store.applyRetention(30, now)).toBe(1)
    expect((await store.list()).map((x) => x.id)).toEqual([m.id])
    expect(await store.applyRetention(0, now)).toBe(0)
    await store.delete(m.id)
    expect(await store.list()).toEqual([])
  })

  it('moves saved meetings to a new folder, keeping later writes and screenshot paths', async () => {
    const store = new MeetingStore(path.join(dir, 'meetings'))
    const m = record('2026-10-01_abc', Date.now())
    await store.save(m)
    await store.appendSegment(m.id, seg('s1', 'first', 1000))
    await mkdir(store.screensDir(m.id), { recursive: true })
    await writeFile(path.join(store.screensDir(m.id), 'shot.jpg'), 'jpg')
    await store.save({ ...m, snapshots: [{ id: 'shot', at: 1, imagePath: path.join(store.screensDir(m.id), 'shot.jpg') } as ScreenSnapshot] })
    await mkdir(path.join(store.cacheDir, 'live'), { recursive: true })

    const next = path.join(dir, 'project', 'meetings')
    const pending = store.appendSegment(m.id, seg('s2', 'queued before the move', 2000))
    expect(await store.relocate(next)).toEqual({ moved: 1, left: 0 })
    await pending
    await store.appendSegment(m.id, seg('s3', 'after the move', 3000))

    expect(store.root).toBe(next)
    expect(store.cacheDir).toBe(path.join(next, '.session-cache'))
    const loaded = await store.get(m.id)
    expect(loaded?.segments.map((s) => s.text)).toEqual(['first', 'queued before the move', 'after the move'])
    expect(loaded?.snapshots[0]?.imagePath).toBe(path.join(next, m.id, 'screens', 'shot.jpg'))
    expect(await readFile(loaded!.snapshots[0]!.imagePath!, 'utf8')).toBe('jpg')
    // The old folder held only meetings and the session cache, so it is gone.
    await expect(stat(path.join(dir, 'meetings'))).rejects.toThrow()
    await expect(store.relocate(path.join(next, m.id, 'sub'))).rejects.toThrow(/outside the saved meetings/)
  })

  it('delete-all removes only meeting folders from a user-chosen folder', async () => {
    const root = path.join(dir, 'chosen')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'notes.txt'), 'keep me')
    await mkdir(path.join(root, 'other.stuff'))
    const store = new MeetingStore(root)
    await store.save(record('2026-10-01_abc', Date.now()))
    await store.deleteAll()
    expect(await store.list()).toEqual([])
    expect((await readdir(root)).sort()).toEqual(['notes.txt', 'other.stuff'])
  })

  it('rejects path-traversal ids', async () => {
    const store = new MeetingStore(path.join(dir, 'meetings'))
    await expect(store.get('../../etc')).rejects.toThrow(/Invalid meeting id/)
  })
})
