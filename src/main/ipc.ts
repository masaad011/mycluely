import { clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { InvokeChannel, InvokeMap } from '@shared/ipc'
import type { DeepPartial, Settings } from '@shared/settings'
import { meetingToMarkdown, meetingToText } from '@shared/export'
import { PROVIDER_IDS, type AssistantAction, type CredentialStatus, type MeetingMode, type ProviderId } from '@shared/types'
import { slugify } from '@shared/util'
import type { ProviderRegistry } from './providers/registry'
import type { ChatGPTAuth } from './services/chatgpt-auth'
import type { CredentialStore } from './services/credential-store'
import type { MeetingStore } from './services/meeting-store'
import type { SettingsStore } from './services/settings-store'
import type { SessionController } from './session/controller'
import type { WindowManager } from './windows'

export interface IpcContext {
  windows: WindowManager
  settings: SettingsStore
  credentials: CredentialStore
  chatgpt: ChatGPTAuth
  /** API-key status plus the ChatGPT sign-in, as shown in Settings. */
  credentialStatus: () => Promise<Record<ProviderId, CredentialStatus>>
  registry: ProviderRegistry
  store: MeetingStore
  session: SessionController
  /** Clipboard writer; tests substitute one so they never touch the real clipboard. */
  writeClipboard?: (text: string) => void
}

type Handler<K extends InvokeChannel> = (...args: InvokeMap[K]['args']) => Promise<InvokeMap[K]['result']> | InvokeMap[K]['result']

const ACTIONS: AssistantAction[] = ['answer', 'screen-answer', 'suggest', 'explain-screen', 'summarize', 'ask', 'refine']
const MODES: MeetingMode[] = ['general', 'technical', 'standup', 'client']

function assertProvider(p: unknown): asserts p is ProviderId {
  if (!PROVIDER_IDS.includes(p as ProviderId)) throw new Error('Unknown provider')
}

function assertString(v: unknown, max = 10_000): asserts v is string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument')
}

/** Registers all UI → main calls. Every call is checked to come from one of our UI windows. */
export function registerIpc(ctx: IpcContext): void {
  const { windows, settings, credentials, registry, store, session, chatgpt, credentialStatus } = ctx
  const writeClipboard = ctx.writeClipboard ?? ((text: string) => clipboard.writeText(text))

  const handle = <K extends InvokeChannel>(channel: K, fn: Handler<K>): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!windows.isUiSender(event.sender)) throw new Error('Unauthorized IPC sender')
      return fn(...(args as InvokeMap[K]['args']))
    })
  }

  handle('app:snapshot', () => session.snapshot())
  handle('settings:get', () => settings.get())
  handle('settings:update', (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings')
    return settings.update(patch as DeepPartial<Settings>)
  })
  handle('settings:reset', () => settings.reset())

  const credentialsChanged = async (provider: ProviderId): Promise<Record<ProviderId, CredentialStatus>> => {
    registry.reset(provider)
    const status = await credentialStatus()
    windows.send('credentials', status)
    void session.refreshStatus()
    return status
  }
  handle('credentials:status', () => credentialStatus())
  handle('credentials:set', async (provider, apiKey) => {
    assertProvider(provider)
    assertString(apiKey, 4096)
    if (provider === 'chatgpt') throw new Error('Use “Continue with ChatGPT” to connect your ChatGPT plan.')
    await credentials.set(provider, apiKey)
    return credentialsChanged(provider)
  })
  handle('credentials:clear', async (provider) => {
    assertProvider(provider)
    await credentials.clear(provider)
    return credentialsChanged(provider)
  })
  handle('chatgpt:sign-in', async () => {
    await chatgpt.signIn()
    return credentialsChanged('chatgpt')
  })
  handle('chatgpt:cancel', () => chatgpt.cancel())
  handle('chatgpt:sign-out', async (forgetAccount) => {
    const r = await chatgpt.signOut(!!forgetAccount)
    await credentialsChanged('chatgpt')
    return r
  })
  handle('providers:test', async (provider) => {
    assertProvider(provider)
    const result = await registry.test(provider)
    if (result.ok) void session.refreshStatus()
    return result
  })
  handle('providers:models', (provider, refresh) => {
    assertProvider(provider)
    return registry.listModels(provider, !!refresh)
  })

  handle('session:start', (opts) => {
    const title = typeof opts?.title === 'string' ? opts.title.slice(0, 200) : undefined
    const mode = MODES.includes(opts?.mode as MeetingMode) ? opts.mode : undefined
    return session.start({ title, mode })
  })
  handle('session:pause', () => session.pause())
  handle('session:resume', () => session.resume())
  handle('session:stop', () => session.stop())
  handle('session:rename', (title) => {
    assertString(title, 200)
    return session.rename(title)
  })
  handle('session:set-mode', (mode) => {
    if (!MODES.includes(mode)) throw new Error('Invalid mode')
    session.setMode(mode)
  })

  handle('screen:sources', () => session.listSources())
  handle('screen:select', (id) => {
    if (id !== null) assertString(id, 200)
    return session.selectSource(id)
  })
  handle('screen:select-region', () => session.selectRegion())
  handle('screen:clear-region', () => session.clearRegion())
  handle('screen:capture', () => session.captureScreen('manual'))
  handle('screen:auto', (enabled, intervalSec) => {
    const interval = typeof intervalSec === 'number' && intervalSec >= 3 && intervalSec <= 600 ? intervalSec : undefined
    void settings.update({ screen: { autoCapture: !!enabled, ...(interval ? { intervalSec: interval } : {}) } })
    session.setAutoCapture(!!enabled, interval)
  })

  handle('assistant:run', (req) => {
    if (!req || !ACTIONS.includes(req.action)) throw new Error('Invalid action')
    if (req.prompt !== undefined) assertString(req.prompt, 8000)
    return session.runAction(req)
  })
  handle('assistant:regenerate', (id) => {
    assertString(id, 100)
    return session.assistant.regenerate(id)
  })
  handle('assistant:refine', (id, instruction) => {
    assertString(id, 100)
    assertString(instruction, 2000)
    return session.assistant.refine(id, instruction)
  })
  handle('assistant:cancel', (id) => {
    assertString(id, 100)
    session.assistant.cancel(id)
  })
  handle('questions:dismiss', (id) => {
    assertString(id, 100)
    session.dismissQuestion(id)
  })
  handle('auto:set-paused', (paused) => {
    session.setAutoPaused(!!paused)
  })

  handle('history:list', () => store.list())
  handle('history:get', async (id) => {
    assertString(id, 100)
    if (id === session.meeting.id) return session.meeting.record
    return (await store.get(id)) ?? null
  })
  handle('history:delete', async (id) => {
    assertString(id, 100)
    await store.delete(id)
  })
  handle('history:delete-all', async () => {
    await store.deleteAll()
  })
  handle('history:export', async (id, format) => {
    assertString(id, 100)
    const record = id === session.meeting.id ? session.meeting.record : await store.get(id)
    if (!record) throw new Error('Meeting not found')
    const content = format === 'txt' ? meetingToText(record) : meetingToMarkdown(record, { includeScreens: true })
    const ext = format === 'txt' ? 'txt' : 'md'
    const owner = windows.main ?? undefined
    const opts = {
      title: 'Export meeting',
      defaultPath: `${slugify(record.title)}.${ext}`,
      filters: [format === 'txt' ? { name: 'Text', extensions: ['txt'] } : { name: 'Markdown', extensions: ['md'] }]
    }
    const res = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await fs.mkdir(path.dirname(res.filePath), { recursive: true })
    await fs.writeFile(res.filePath, content, 'utf8')
    return res.filePath
  })

  handle('window:toggle-overlay', () => windows.toggleOverlay())
  handle('window:show-main', (view) => windows.showMain(view))
  handle('window:hide-overlay', () => windows.hideOverlay())
  handle('window:overlay-collapse', (collapsed, barHeight) => {
    const h = Number(barHeight)
    if (!Number.isFinite(h) || h < 24 || h > 200) throw new Error('Invalid panel height')
    return windows.setOverlayCollapsed(!!collapsed, h)
  })
  handle('window:set-overlay-top', (onTop) => {
    windows.setOverlayOnTop(!!onTop)
    void settings.update({ ui: { overlayAlwaysOnTop: !!onTop } })
  })
  handle('clipboard:write', async (text) => {
    assertString(text, 200_000)
    writeClipboard(text)
  })
  handle('shell:open-external', async (url) => {
    assertString(url, 2000)
    if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be opened')
    await shell.openExternal(url)
  })
}
