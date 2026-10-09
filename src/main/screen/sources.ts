import { desktopCapturer, screen } from 'electron'
import type { CaptureSource, Rect } from '@shared/types'
import type { ScreenSourceProvider } from '../session/ports'
import type { WindowManager } from '../windows'

/** Screen/window discovery via Electron's desktopCapturer (Windows Graphics Capture on Win11). */
export class ElectronScreenSources implements ScreenSourceProvider {
  constructor(private readonly windows: WindowManager) {}

  async list(): Promise<CaptureSource[]> {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
    const own = new Set(this.windows.ownMediaSourceIds())
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const out: CaptureSource[] = []
    let screenIndex = 0
    for (const s of sources) {
      const kind = s.id.startsWith('screen:') ? 'screen' : 'window'
      if (kind === 'window' && (own.has(s.id) || !s.name.trim() || /^MyCluely( |$)/.test(s.name))) continue
      let name = s.name
      if (kind === 'screen') {
        screenIndex++
        const d = displays.find((x) => String(x.id) === s.display_id)
        if (d) {
          const px = `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`
          name = `Screen ${screenIndex}${d.id === primary.id ? ' (primary)' : ''} — ${px}`
        }
      }
      out.push({
        id: s.id,
        name,
        kind,
        displayId: s.display_id || undefined,
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined
      })
    }
    // Primary screen first, then other screens, then windows.
    return out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'screen' ? -1 : 1
      if (a.kind === 'screen') return Number(b.name.includes('(primary)')) - Number(a.name.includes('(primary)'))
      return 0
    })
  }

  displayBounds(source: CaptureSource): Rect | undefined {
    const d = screen.getAllDisplays().find((x) => String(x.id) === source.displayId)
    return (d ?? (source.kind === 'screen' ? screen.getPrimaryDisplay() : undefined))?.bounds
  }

  ownWindowRects(): Rect[] {
    return this.windows.ownWindowRects()
  }

  pickRegion(displayId: string | undefined): Promise<Rect | null> {
    const d = screen.getAllDisplays().find((x) => String(x.id) === displayId) ?? screen.getPrimaryDisplay()
    return this.windows.pickRegion(d)
  }
}
