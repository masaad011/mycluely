import { BrowserWindow, ipcMain, nativeTheme, screen, shell, systemPreferences, type Display, type WebContents } from 'electron'
import path from 'node:path'
import type { EventChannel, EventMap, ThemeState } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { resolveTheme, themeInfo } from '@shared/themes'
import type { Rect } from '@shared/types'
import { APP_ORIGIN } from './app-protocol'
import type { Broadcaster } from './session/ports'
import { readJson, writeFileAtomic } from './services/json-file'

type Page = 'index' | 'overlay' | 'capture' | 'region'

interface WindowState {
  main?: Electron.Rectangle & { maximized?: boolean }
  overlay?: Electron.Rectangle
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']
/** Automated tests: keep UI windows hidden so test runs never pop up on (or take input from) the desktop. */
export const HEADLESS_UI = process.env['MYCLUELY_HEADLESS_UI'] === '1'

function pageUrl(page: Page): string {
  const file = `${page}.html`
  if (isDev) return `${process.env['ELECTRON_RENDERER_URL']}/${file}`
  return `${APP_ORIGIN}/${file}`
}

/** Owns every BrowserWindow and applies the security baseline to each. */
export class WindowManager implements Broadcaster {
  main: BrowserWindow | null = null
  overlay: BrowserWindow | null = null
  capture: BrowserWindow | null = null
  region: BrowserWindow | null = null
  private state: WindowState = {}
  private readonly stateFile: string
  private quitting = false
  private themeWatched = false
  private regionResolve: ((r: Rect | null) => void) | null = null

  constructor(
    private readonly preload: string,
    private readonly settings: () => Settings,
    userData: string,
    private readonly onCaptureCrashed: () => void
  ) {
    this.stateFile = path.join(userData, 'window-state.json')
  }

  async loadState(): Promise<void> {
    this.state = (await readJson<WindowState>(this.stateFile)) ?? {}
  }

  setQuitting(): void {
    this.quitting = true
  }

  private secure(win: BrowserWindow): void {
    const wc = win.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
      if (url !== wc.getURL()) e.preventDefault()
    })
    wc.on('will-attach-webview', (e) => e.preventDefault())
  }

  private prefs(extra: Electron.WebPreferences = {}): Electron.WebPreferences {
    return {
      ...(HEADLESS_UI ? { backgroundThrottling: false } : {}),
      preload: this.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      ...extra
    }
  }

  private saveStateSoon = debounce(() => {
    const st: WindowState = { ...this.state }
    if (this.main && !this.main.isDestroyed()) {
      st.main = { ...this.main.getNormalBounds(), maximized: this.main.isMaximized() }
    }
    if (this.overlay && !this.overlay.isDestroyed()) st.overlay = this.overlay.getBounds()
    this.state = st
    void writeFileAtomic(this.stateFile, JSON.stringify(st)).catch(() => undefined)
  }, 800)

  private visibleOn(b?: Electron.Rectangle): Electron.Rectangle | undefined {
    if (!b) return undefined
    const ok = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return b.x < wa.x + wa.width - 40 && b.x + b.width > wa.x + 40 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 40
    })
    return ok ? b : undefined
  }

  createMain(): BrowserWindow {
    const saved = this.visibleOn(this.state.main)
    const win = new BrowserWindow({
      width: saved?.width ?? 1320,
      height: saved?.height ?? 860,
      x: saved?.x,
      y: saved?.y,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: this.background(),
      title: 'MyCluely',
      autoHideMenuBar: true,
      webPreferences: this.prefs()
    })
    this.secure(win)
    win.once('ready-to-show', () => {
      if (HEADLESS_UI) return
      if (this.state.main?.maximized) win.maximize()
      win.show()
    })
    win.on('resize', this.saveStateSoon)
    win.on('move', this.saveStateSoon)
    win.on('closed', () => {
      this.main = null
    })
    void win.loadURL(pageUrl('index'))
    this.main = win
    this.applyContentProtection()
    return win
  }

  createOverlay(): BrowserWindow {
    const s = this.settings().ui
    const wa = screen.getPrimaryDisplay().workArea
    const saved = this.visibleOn(this.state.overlay)
    const width = saved?.width ?? 420
    const height = saved?.height ?? 560
    const win = new BrowserWindow({
      width,
      height,
      x: saved?.x ?? wa.x + wa.width - width - 24,
      y: saved?.y ?? wa.y + 24,
      minWidth: 320,
      minHeight: 200,
      show: false,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: this.background(),
      title: 'MyCluely Assistant',
      webPreferences: this.prefs()
    })
    this.secure(win)
    win.setOpacity(s.overlayOpacity)
    win.setAlwaysOnTop(s.overlayAlwaysOnTop, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('resize', this.saveStateSoon)
    win.on('move', this.saveStateSoon)
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => {
      this.overlay = null
    })
    void win.loadURL(pageUrl('overlay'))
    this.overlay = win
    this.applyContentProtection()
    return win
  }

  /** Hidden renderer that owns audio/screen streams and on-device Whisper. */
  createCapture(): BrowserWindow {
    const win = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      skipTaskbar: true,
      title: 'MyCluely capture engine',
      webPreferences: this.prefs({ backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' })
    })
    this.secure(win)
    win.webContents.on('render-process-gone', () => {
      if (this.quitting) return
      this.capture = null
      win.destroy()
      this.onCaptureCrashed()
    })
    win.on('closed', () => {
      if (this.capture === win) this.capture = null
    })
    void win.loadURL(pageUrl('capture'))
    this.capture = win
    return win
  }

  uiWindows(): BrowserWindow[] {
    return [this.main, this.overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
  }

  send<K extends EventChannel>(channel: K, payload: EventMap[K]): void {
    for (const w of this.uiWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send(`evt:${channel}`, payload)
    }
  }

  isUiSender(wc: WebContents): boolean {
    return this.uiWindows().some((w) => w.webContents.id === wc.id)
  }

  isCaptureSender(wc: WebContents): boolean {
    return !!this.capture && !this.capture.isDestroyed() && this.capture.webContents.id === wc.id
  }

  isRegionSender(wc: WebContents): boolean {
    return !!this.region && !this.region.isDestroyed() && this.region.webContents.id === wc.id
  }

  showMain(view?: 'live' | 'history' | 'settings'): void {
    if (!this.main || this.main.isDestroyed()) this.createMain()
    const w = this.main!
    if (view) w.webContents.send('evt:navigate', view)
    if (HEADLESS_UI) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  showOverlay(focus = false): void {
    if (!this.overlay || this.overlay.isDestroyed()) this.createOverlay()
    if (HEADLESS_UI) return
    const w = this.overlay!
    if (focus) w.show()
    else w.showInactive()
    if (focus) w.focus()
  }

  hideOverlay(): void {
    this.overlay?.hide()
  }

  toggleOverlay(): void {
    if (this.overlay?.isVisible()) this.hideOverlay()
    else this.showOverlay()
  }

  /** The theme in effect: Settings → Appearance, with System following the Windows app mode. */
  themeState(): ThemeState {
    const id = resolveTheme(this.settings().ui.theme, nativeTheme.shouldUseDarkColors)
    let systemAccent: string | undefined
    try {
      const raw = systemPreferences.getAccentColor?.()
      if (raw && /^[0-9a-f]{6}/i.test(raw)) systemAccent = `#${raw.slice(0, 6)}`
    } catch {
      // Not available on this platform.
    }
    return { id, systemAccent }
  }

  /** Window background before the page paints (the theme's --bg), so nothing flashes. */
  private background(): string {
    return themeInfo(this.themeState().id).background
  }

  /**
   * Apply Settings → Appearance: the native light/dark mode (title bar, menus, form controls)
   * follows the theme's scheme, and every window repaints with the theme in effect.
   */
  applyTheme(): void {
    if (!this.themeWatched) {
      this.themeWatched = true
      // Fires when Windows switches light/dark while the theme is "System"…
      nativeTheme.on('updated', () => this.pushTheme())
      // …and when the Windows accent colour changes.
      systemPreferences.on?.('accent-color-changed', () => this.pushTheme())
    }
    const pref = this.settings().ui.theme
    nativeTheme.themeSource = pref === 'system' ? 'system' : themeInfo(pref).scheme
    this.pushTheme()
  }

  private pushTheme(): void {
    const bg = this.background()
    for (const win of this.uiWindows()) win.setBackgroundColor(bg)
    this.send('theme', this.themeState())
  }

  applyOverlaySettings(): void {
    const s = this.settings().ui
    if (!this.overlay || this.overlay.isDestroyed()) return
    this.overlay.setOpacity(s.overlayOpacity)
    this.overlay.setAlwaysOnTop(s.overlayAlwaysOnTop, 'screen-saver')
  }

  setOverlayOnTop(onTop: boolean): void {
    this.overlay?.setAlwaysOnTop(onTop, 'screen-saver')
  }

  /** Optional privacy feature: keep MyCluely windows out of screenshots and screen shares. */
  applyContentProtection(): void {
    const on = this.settings().privacy.hideFromCapture
    for (const w of [this.main, this.overlay]) if (w && !w.isDestroyed()) w.setContentProtection(on)
  }

  ownMediaSourceIds(): string[] {
    return [this.main, this.overlay, this.region]
      .filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
      .map((w) => w.getMediaSourceId())
  }

  /** DIP rectangles of our visible windows (masked out of full-screen captures). */
  ownWindowRects(): Rect[] {
    if (this.settings().privacy.hideFromCapture) return [] // already excluded by the OS
    return this.uiWindows()
      .filter((w) => w.isVisible() && !w.isMinimized())
      .map((w) => w.getBounds())
  }

  pickRegion(display: Display): Promise<Rect | null> {
    this.regionResolve?.(null)
    this.region?.destroy()
    return new Promise((resolve) => {
      const b = display.bounds
      const win = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
        webPreferences: this.prefs()
      })
      this.secure(win)
      win.setAlwaysOnTop(true, 'screen-saver')
      this.region = win
      let settled = false
      const finish = (r: Rect | null): void => {
        if (settled) return
        settled = true
        this.regionResolve = null
        if (!win.isDestroyed()) win.destroy()
        if (this.region === win) this.region = null
        resolve(r ? { x: r.x + b.x, y: r.y + b.y, width: r.width, height: r.height } : null)
      }
      this.regionResolve = finish
      win.on('closed', () => finish(null))
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('evt:region-init', { displayLabel: display.label || `Display ${display.id}` })
        win.show()
        win.focus()
      })
      void win.loadURL(pageUrl('region'))
    })
  }

  /** Called from IPC when the region page reports a selection (in window DIP coords). */
  resolveRegion(rect: Rect | null): void {
    this.regionResolve?.(rect)
  }
}

export function registerRegionIpc(windows: WindowManager): void {
  ipcMain.handle('region:done', (e, rect: Rect | null) => {
    if (!windows.isRegionSender(e.sender)) throw new Error('Unauthorized')
    const valid =
      rect &&
      [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      rect.width > 4 &&
      rect.height > 4
    windows.resolveRegion(valid ? rect : null)
  })
}

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}
