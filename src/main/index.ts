import { app, BrowserWindow, desktopCapturer, Menu, nativeImage, nativeTheme, safeStorage, session, shell, Tray } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import trayIconPath from '../../resources/icon.png?asset'
import type { Settings } from '@shared/settings'
import { handleAppScheme, registerAppScheme } from './app-protocol'
import { ElectronCaptureDriver } from './capture-driver'
import { registerIpc } from './ipc'
import { ProviderRegistry } from './providers/registry'
import { OcrService } from './screen/ocr'
import { ElectronScreenSources } from './screen/sources'
import { ChatGPTAuth } from './services/chatgpt-auth'
import { CredentialStore, type Encryptor } from './services/credential-store'
import { MeetingStore } from './services/meeting-store'
import { keepConnectionsAlive } from './services/network'
import { SettingsStore } from './services/settings-store'
import { SessionController } from './session/controller'
import { ShortcutManager } from './shortcuts'
import { HEADLESS_UI, registerRegionIpc, WindowManager } from './windows'

// Isolated profile for tests / portable use.
if (process.env['MYCLUELY_USER_DATA']) app.setPath('userData', path.resolve(process.env['MYCLUELY_USER_DATA']))

registerAppScheme()

// A second launch just focuses the running instance (see 'second-instance'); it must not run
// bootstrap, which would clean up the first instance's session cache.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

app.setAppUserModelId('com.mycluely.app')

/** Electron safeStorage (DPAPI on Windows, Keychain on macOS) using the async API throughout. */
const encryptor: Encryptor = {
  isAvailable: async () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (cipher) => {
    const r = await safeStorage.decryptStringAsync(cipher)
    return { value: r.result, shouldReEncrypt: r.shouldReEncrypt }
  }
}

function tessdataPath(): string {
  const pkg = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'))
  const dir = path.join(pkg, '4.0.0_best_int')
  return dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

let quitting = false

async function bootstrap(): Promise<void> {
  keepConnectionsAlive()
  const userData = app.getPath('userData')
  const cacheDir = path.join(userData, 'session-cache')
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)

  const settings = await SettingsStore.open(userData)
  const credentials = new CredentialStore(userData, encryptor)
  // Tests may point "Sign in with ChatGPT" at a local mock (only with test hooks enabled).
  const testHooks = process.env['MYCLUELY_TEST_HOOKS'] === '1'
  const chatgpt = new ChatGPTAuth({
    dir: userData,
    encryptor,
    appName: 'MyCluely',
    issuer: testHooks ? process.env['MYCLUELY_CHATGPT_ISSUER'] : undefined,
    resource: testHooks ? process.env['MYCLUELY_CHATGPT_RESOURCE'] : undefined,
    redirectPort: testHooks && process.env['MYCLUELY_CHATGPT_PORT'] ? Number(process.env['MYCLUELY_CHATGPT_PORT']) : undefined,
    openUrl: (url) =>
      testHooks && process.env['MYCLUELY_CHATGPT_ISSUER']
        ? void fetch(url).catch(() => undefined) // simulated browser that approves the request
        : shell.openExternal(url)
  })
  await chatgpt.init()
  const registry = new ProviderRegistry(
    (id) => credentials.get(id),
    () => settings.get(),
    chatgpt,
    testHooks ? process.env['MYCLUELY_CHATGPT_RESOURCE'] : undefined
  )
  const credentialStatus = async (): Promise<Awaited<ReturnType<CredentialStore['status']>>> => ({
    ...(await credentials.status()),
    chatgpt: chatgpt.credentialStatus()
  })
  const store = new MeetingStore(path.join(userData, 'meetings'))
  const ocr = new OcrService({ langPath: tessdataPath(), cachePath: path.join(userData, 'ocr-cache') })

  handleAppScheme(path.join(__dirname, '../renderer'))

  let driver: ElectronCaptureDriver
  const windows = new WindowManager(path.join(__dirname, '../preload/index.js'), () => settings.get(), userData, () => {
    driver.onCrashed()
    setTimeout(() => windows.createCapture(), 1000)
  })
  await windows.loadState()
  windows.applyTheme()

  let controller: SessionController
  driver = new ElectronCaptureDriver(windows, {
    segment: (m) => controller.onAudioSegment(m),
    levels: (l) => controller.onLevels(l),
    channel: (m) => controller.onChannel(m),
    devices: (d) => controller.onDevices(d),
    sttProgress: (p) => {
      const detail =
        p.status === 'loading'
          ? `Loading on-device Whisper${p.progress !== undefined ? ` ${Math.round(p.progress)}%` : '…'}`
          : p.status === 'ready'
            ? `On-device Whisper ready (${p.device ?? 'cpu'})`
            : p.message
      controller.setTranscriptionDetail(detail)
    },
    log: (level, message) => {
      if (level === 'error') console.error('[capture]', message)
      else if (process.env['MYCLUELY_DEBUG']) console.log('[capture]', message)
    }
  })
  driver.attach()

  controller = new SessionController({
    settings: () => settings.get(),
    registry,
    credentials: credentialStatus,
    store,
    capture: driver,
    screens: new ElectronScreenSources(windows),
    ocr,
    broadcaster: windows,
    cacheDir,
    platform: process.platform,
    version: app.getVersion(),
    theme: () => windows.themeState(),
    // Show automatic answers as they arrive, without taking focus from the meeting.
    onAutoAnswer: () => {
      if (settings.get().ui.showOverlayOnAutoAnswer) windows.showOverlay()
    }
  })

  // --- Permissions: only the capture engine may use microphone/screen; nothing else is granted.
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') return callback(windows.isCaptureSender(wc))
    if (permission === 'clipboard-sanitized-write') return callback(windows.isUiSender(wc))
    callback(false)
  })
  ses.setPermissionCheckHandler((wc, permission) => {
    if (!wc) return false
    if (permission === 'media' || permission === 'display-capture') return windows.isCaptureSender(wc)
    if (permission === 'clipboard-sanitized-write') return windows.isUiSender(wc)
    return false
  })
  // System audio: getDisplayMedia from the capture engine gets Windows loopback audio.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame
    const fromCapture = !!frame && !!windows.capture && frame.processId === windows.capture.webContents.getProcessId()
    if (!fromCapture) return callback(null as unknown as Electron.Streams)
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources[0]) return callback(null as unknown as Electron.Streams)
        callback({ video: sources[0], audio: request.audioRequested ? 'loopback' : undefined })
      })
      .catch(() => callback(null as unknown as Electron.Streams))
  })

  // Automated tests only: copies go to a list instead of the real clipboard (see below).
  const testClipboard: string[] = []
  registerIpc({
    windows,
    settings,
    credentials,
    chatgpt,
    credentialStatus,
    registry,
    store,
    session: controller,
    writeClipboard: process.env['MYCLUELY_TEST_HOOKS'] === '1' ? (text) => void testClipboard.push(text) : undefined
  })
  // Sign-in expiry/revocation discovered during a request updates Settings and the status bar.
  chatgpt.onChange(() => {
    registry.reset('chatgpt')
    void credentialStatus().then((st) => windows.send('credentials', st))
    void controller.refreshStatus()
  })
  // Automated tests only: lets the E2E suite inject audio as if it came from system audio, and
  // read what was copied.
  if (process.env['MYCLUELY_TEST_HOOKS'] === '1') {
    ;(globalThis as unknown as { __mycluelyTest: unknown }).__mycluelyTest = { controller, settings, clipboard: testClipboard }
  }
  registerRegionIpc(windows)

  windows.createCapture()
  windows.createMain()
  windows.createOverlay()

  // --- Shortcuts
  const run = (action: Parameters<SessionController['runAction']>[0]['action']) => () => {
    windows.showOverlay()
    void controller.runAction({ action }).catch((e) => controller.toast('error', String(e?.message ?? e)))
  }
  const shortcuts = new ShortcutManager({
    toggleOverlay: () => windows.toggleOverlay(),
    answer: run('answer'),
    suggest: run('suggest'),
    explainScreen: run('explain-screen'),
    summarize: run('summarize'),
    captureScreen: () => void controller.captureScreen('manual'),
    togglePause: () => controller.togglePause(),
    toggleAutoAnswer: () => {
      const paused = !controller.autoAnswerPaused
      controller.setAutoPaused(paused)
      controller.toast('info', paused ? 'Auto-answer paused.' : 'Auto-answer resumed.')
    },
    focusAsk: () => {
      windows.showOverlay(true)
      windows.overlay?.webContents.send('evt:focus-ask', null)
    }
  })
  let reportedShortcutFailures = ''
  const applyShortcuts = (s: Settings): void => {
    if (HEADLESS_UI) return // automated tests must never grab the desktop's keyboard shortcuts
    const st = controller.getStatus().session
    const failed = shortcuts.apply(s.shortcuts, st === 'running' || st === 'paused' || st === 'starting')
    const key = failed.join('; ')
    if (failed.length && key !== reportedShortcutFailures) {
      controller.toast('warning', 'Some keyboard shortcuts could not be registered', key)
    }
    reportedShortcutFailures = key
  }
  applyShortcuts(settings.get())

  // --- Tray
  const tray = HEADLESS_UI ? null : new Tray(nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 }))
  tray?.setToolTip('MyCluely')
  const rebuildTray = (): void => {
    if (!tray) return
    const st = controller.getStatus().session
    const live = st === 'running' || st === 'paused'
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open MyCluely', click: () => windows.showMain() },
        { label: 'Show / hide assistant panel', click: () => windows.toggleOverlay() },
        { type: 'separator' },
        st === 'stopping' || st === 'starting'
          ? { label: st === 'stopping' ? 'Finishing meeting…' : 'Starting…', enabled: false }
          : live
            ? { label: 'Stop meeting', click: () => void controller.stop() }
            : { label: 'Start meeting', click: () => void controller.start() },
        { label: st === 'paused' ? 'Resume capture' : 'Pause capture', enabled: live, click: () => controller.togglePause() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }
  rebuildTray()
  tray?.on('click', () => windows.showMain())

  controller.on('started', () => {
    rebuildTray()
    if (settings.get().ui.showOverlayOnStart) windows.showOverlay()
  })
  controller.on('session', () => {
    rebuildTray()
    applyShortcuts(settings.get())
  })

  // --- Settings changes
  settings.on('change', (next: Settings, prev: Settings) => {
    windows.send('settings', next)
    windows.applyOverlaySettings()
    if (next.ui.theme !== prev.ui.theme) windows.applyTheme()
    if (next.assistant.autoSuggest !== prev.assistant.autoSuggest) controller.autoAnswerChanged()
    if (next.privacy.hideFromCapture !== prev.privacy.hideFromCapture) windows.applyContentProtection()
    if (JSON.stringify(next.shortcuts) !== JSON.stringify(prev.shortcuts)) applyShortcuts(next)
    if (JSON.stringify(next.ai.baseUrls) !== JSON.stringify(prev.ai.baseUrls) || next.ai.moonshotRegion !== prev.ai.moonshotRegion) {
      registry.reset()
    }
    if (next.privacy.retentionDays !== prev.privacy.retentionDays) void store.applyRetention(next.privacy.retentionDays)
    void controller.refreshStatus()
  })

  // --- Retention
  const retention = async (): Promise<void> => {
    const n = await store.applyRetention(settings.get().privacy.retentionDays).catch(() => 0)
    if (n) controller.toast('info', `Deleted ${n} meeting${n === 1 ? '' : 's'} older than the retention period.`)
  }
  void retention()
  setInterval(() => void retention(), 6 * 3600_000).unref()

  void controller.refreshStatus()
  void controller.listSources().catch(() => undefined)

  app.on('second-instance', () => windows.showMain())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMain()
    else windows.showMain()
  })

  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    windows.setQuitting()
    shortcuts.clear()
    tray?.destroy()
    void Promise.race([
      (async () => {
        await controller.shutdown()
        await ocr.terminate()
      })(),
      new Promise((r) => setTimeout(r, 5000))
    ]).finally(() => app.quit())
  })

  // Closing the main window quits the app (the overlay alone is not a "main" window).
  windows.main?.on('closed', () => {
    if (!quitting) app.quit()
  })
}

if (gotSingleInstanceLock) {
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error('Failed to start MyCluely', err)
      app.exit(1)
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
