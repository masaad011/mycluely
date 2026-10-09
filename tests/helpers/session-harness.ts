import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CaptureCommand, EventChannel, EventMap, GrabRequest, GrabResult } from '@shared/ipc'
import type { DeepPartial, Settings } from '@shared/settings'
import type { CaptureSource, Rect } from '@shared/types'
import { ProviderRegistry } from '../../src/main/providers/registry'
import { OcrService } from '../../src/main/screen/ocr'
import { CredentialStore, type Encryptor } from '../../src/main/services/credential-store'
import { MeetingStore } from '../../src/main/services/meeting-store'
import { deepMerge } from '../../src/main/services/settings-schema'
import { SettingsStore } from '../../src/main/services/settings-store'
import { SessionController } from '../../src/main/session/controller'
import type { Broadcaster, CaptureDriver, ScreenSourceProvider } from '../../src/main/session/ports'
import { startMockProviders, type MockOptions, type MockServer } from './mock-providers'

export const FIXTURES = path.join(__dirname, '../fixtures')

const plainEncryptor: Encryptor = {
  isAvailable: async () => true,
  encrypt: async (s) => Buffer.from(s),
  decrypt: async (b) => ({ value: b.toString(), shouldReEncrypt: false })
}

/** Stand-in for the hidden capture renderer: records commands, returns the slide fixture. */
export class FakeCapture implements CaptureDriver {
  commands: CaptureCommand[] = []
  grabs: Omit<GrabRequest, 'requestId'>[] = []
  /** Brightness of the fake change signature; change it to simulate new screen content. */
  shade = 200
  /** Fixture image the fake screen shows (read by real OCR). */
  image = 'slide.png'
  /** Probe (change-check) requests, kept apart from full captures. */
  probes = 0
  command(cmd: CaptureCommand): void {
    this.commands.push(cmd)
  }
  async grab(req: Omit<GrabRequest, 'requestId'>): Promise<GrabResult> {
    const signature = new Uint8Array(160 * 90).fill(this.shade)
    if (req.probe) {
      this.probes++
      return { requestId: 'p', ok: true, width: 1600, height: 900, signature, blankness: 0.7 }
    }
    this.grabs.push(req)
    const png = readFileSync(path.join(FIXTURES, this.image))
    return {
      requestId: 'g',
      ok: true,
      width: 1600,
      height: 900,
      ocrPng: png,
      visionJpeg: png,
      thumbnail: 'data:image/png;base64,AAAA',
      signature,
      blankness: 0.7
    }
  }
  async localTranscribe(): Promise<string> {
    throw new Error('local transcription is not used in these tests')
  }
}

export class FakeScreens implements ScreenSourceProvider {
  async list(): Promise<CaptureSource[]> {
    return [{ id: 'screen:1:0', name: 'Screen 1 (primary)', kind: 'screen', displayId: '1', thumbnail: '' }]
  }
  displayBounds(): Rect {
    return { x: 0, y: 0, width: 1920, height: 1080 }
  }
  ownWindowRects(): Rect[] {
    return [{ x: 1500, y: 0, width: 420, height: 560 }]
  }
  async pickRegion(): Promise<Rect | null> {
    return { x: 0, y: 0, width: 960, height: 540 }
  }
}

export class RecordingBroadcaster implements Broadcaster {
  log: { channel: EventChannel; payload: unknown }[] = []
  send<K extends EventChannel>(channel: K, payload: EventMap[K]): void {
    this.log.push({ channel, payload })
  }
  of<K extends EventChannel>(channel: K): EventMap[K][] {
    return this.log.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
  }
}

export interface Harness {
  dir: string
  mock: MockServer
  settings: SettingsStore
  store: MeetingStore
  ocr: OcrService
  capture: FakeCapture
  events: RecordingBroadcaster
  session: SessionController
  close(): Promise<void>
}

/** A SessionController wired to real services, the mock provider server and fake capture. */
export async function createHarness(
  opts: { settings?: DeepPartial<Settings>; mock?: MockOptions; env?: NodeJS.ProcessEnv; onAutoAnswer?: () => void } = {}
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mycluely-harness-'))
  const mock = await startMockProviders(opts.mock)
  const settings = await SettingsStore.open(dir)
  const base: DeepPartial<Settings> = {
    ai: { provider: 'openai', models: { openai: 'gpt-6.1-sol' } },
    transcription: { engine: 'auto', openaiModel: 'gpt-transcribe' },
    privacy: { saveHistory: true, keepScreenshots: false }
  }
  const merged = deepMerge(base as Record<string, unknown>, (opts.settings ?? {}) as Record<string, unknown>) as DeepPartial<Settings>
  // Every provider points at the local mock so no test can ever reach a real API.
  merged.ai = {
    ...merged.ai,
    baseUrls: { openai: `${mock.url}/openai/v1`, anthropic: `${mock.url}/anthropic`, gemini: `${mock.url}/gemini`, moonshot: `${mock.url}/moonshot/v1`, deepseek: `${mock.url}/deepseek` }
  }
  await settings.update(merged)
  const credentials = new CredentialStore(dir, plainEncryptor, opts.env ?? { OPENAI_API_KEY: 'sk-harness', ANTHROPIC_API_KEY: 'sk-ant-harness' })
  const registry = new ProviderRegistry((id) => credentials.get(id), () => settings.get())
  const store = new MeetingStore(path.join(dir, 'meetings'))
  const ocr = new OcrService({
    langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'),
    cachePath: path.join(dir, 'ocr-cache')
  })
  const capture = new FakeCapture()
  const events = new RecordingBroadcaster()
  const session = new SessionController({
    settings: () => settings.get(),
    registry,
    credentials: () => credentials.status(),
    store,
    capture,
    screens: new FakeScreens(),
    ocr,
    broadcaster: events,
    cacheDir: path.join(dir, 'session-cache'),
    // Screen watching at test speed.
    watcherTimings: { probeMs: 100, settleMs: 150, rereadMs: 600 },
    onAutoAnswer: opts.onAutoAnswer
  })
  await session.refreshStatus()
  return {
    dir,
    mock,
    settings,
    store,
    ocr,
    capture,
    events,
    session,
    async close() {
      await session.shutdown().catch(() => undefined)
      await ocr.terminate()
      await mock.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

export function fixtureWav(name: string): Uint8Array {
  return readFileSync(path.join(FIXTURES, name))
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
