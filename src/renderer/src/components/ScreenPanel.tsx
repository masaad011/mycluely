import { useEffect, useState, type ReactNode } from 'react'
import type { CaptureSource, ScreenSnapshot } from '@shared/types'
import { CAPTURE_INTERVAL_CHOICES } from '@shared/settings'
import { api } from '../lib/api'
import { safe } from '../lib/actions'
import { useStore } from '../lib/store'
import { Modal } from './common'
import { PaneControls } from './Panels'
import { IconCamera, IconCrop, IconMonitor, IconX } from './icons'

export function QualityBadge({ snap }: { snap: ScreenSnapshot }): ReactNode {
  switch (snap.quality) {
    case 'clear':
      return <span className="badge ok">Readable · {Math.round(snap.ocrConfidence)}%</span>
    case 'partial':
      return <span className="badge warn">Partly readable · {Math.round(snap.ocrConfidence)}%</span>
    case 'unreadable':
      return <span className="badge err">Unreadable</span>
    default:
      return <span className="badge">Analyzing…</span>
  }
}

export function SourcePicker({ onClose }: { onClose: () => void }): ReactNode {
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const current = useStore((s) => s.status.screen.sourceId)
  const [loading, setLoading] = useState(false)
  const load = async (): Promise<void> => {
    setLoading(true)
    const list = await safe(() => api.invoke('screen:sources'), 'Could not list screens')
    setSources(list ?? [])
    setLoading(false)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pick = async (id: string): Promise<void> => {
    await safe(() => api.invoke('screen:select', id))
    onClose()
  }
  const screens = sources?.filter((s) => s.kind === 'screen') ?? []
  const windows = sources?.filter((s) => s.kind === 'window') ?? []
  const grid = (list: CaptureSource[]): ReactNode => (
    <div className="source-grid">
      {list.map((s) => (
        <button key={s.id} className={`source${s.id === current ? ' selected' : ''}`} onClick={() => void pick(s.id)}>
          {s.thumbnail ? <img className="thumb" src={s.thumbnail} alt="" /> : <div className="thumb" />}
          <span className="name">
            {s.appIcon && <img src={s.appIcon} alt="" />}
            <span className="ellipsis">{s.name}</span>
          </span>
        </button>
      ))}
    </div>
  )
  return (
    <Modal
      title="Choose what to capture"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {sources === null ? (
        <div className="muted">Loading screens and windows…</div>
      ) : (
        <div className="col" style={{ gap: 16 }}>
          <div className="section-title">Screens</div>
          {grid(screens)}
          <div className="section-title">Windows</div>
          {windows.length ? grid(windows) : <div className="muted small">No capturable windows found.</div>}
          <div className="muted small">
            Tip: to read only part of a screen (e.g. one slide or code panel), pick a screen and then use <b>Region</b>.
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Screen context panel; `collapsed` keeps only its header (with the capture controls). */
export function ScreenPanel({ collapsed = false, grow = false }: { collapsed?: boolean; grow?: boolean }): ReactNode {
  const screen = useStore((s) => s.status.screen)
  const snapshots = useStore((s) => s.snapshots) ?? []
  const [picking, setPicking] = useState(false)
  const [showText, setShowText] = useState(true)
  const latest = snapshots[snapshots.length - 1]
  if (!screen) return null
  return (
    <section className={`screen-panel${collapsed ? ' collapsed' : ''}${grow ? ' grow' : ''}`} aria-label="Screen context" data-testid="panel-screen">
      <div className="pane-head">
        <IconMonitor />
        <h2>Screen</h2>
        <button className="btn sm grow ellipsis" style={{ justifyContent: 'flex-start', maxWidth: 260 }} onClick={() => setPicking(true)} title="Choose screen or window">
          <span className="ellipsis">{screen.sourceName ?? 'Choose screen or window…'}</span>
        </button>
        {screen.region ? (
          <span className="badge accent" title="Capturing a region of the screen">
            Region
            <button className="link" style={{ color: 'inherit', display: 'inline-flex' }} onClick={() => void safe(() => api.invoke('screen:clear-region'))} aria-label="Clear region">
              <IconX width={12} height={12} />
            </button>
          </span>
        ) : (
          <button className="btn sm" onClick={() => void safe(() => api.invoke('screen:select-region'))} title="Select a region of a screen">
            <IconCrop /> Region
          </button>
        )}
        <button className="btn sm" onClick={() => void safe(() => api.invoke('screen:capture'))} disabled={screen.busy} data-testid="capture-now">
          <IconCamera /> {screen.busy ? 'Capturing…' : 'Capture'}
        </button>
        <label className="row small" title="Capture every few seconds while a meeting is running (in Auto answer mode the screen is watched continuously instead)">
          <input type="checkbox" className="switch" checked={screen.auto} onChange={(e) => void safe(() => api.invoke('screen:auto', e.target.checked))} />
          Auto-capture
        </label>
        {screen.auto && (
          <select
            value={screen.intervalSec}
            onChange={(e) => void safe(() => api.invoke('screen:auto', true, Number(e.target.value)))}
            aria-label="Capture interval"
            style={{ minHeight: 26, padding: '2px 26px 2px 8px', backgroundPosition: 'right 7px center' }}
          >
            {CAPTURE_INTERVAL_CHOICES.map((s) => (
              <option key={s} value={s}>
                every {s < 60 ? `${s}s` : `${s / 60} min`}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <PaneControls id="screen" />
      </div>
      {!collapsed && screen.error && (
        <div className="callout warn" style={{ margin: '8px 16px 0' }}>
          {screen.error}
        </div>
      )}
      {!collapsed && (
        <div className="screen-body">
          <div className="col">
            <div className="screen-thumb">
              {latest?.thumbnail ? <img src={latest.thumbnail} alt="Latest screen capture" /> : <span>No capture yet</span>}
            </div>
            {latest && (
              <div className="col" style={{ gap: 4 }}>
                <QualityBadge snap={latest} />
                <span className="tiny muted">
                  {latest.trigger === 'auto' ? 'Auto' : 'Manual'} · {new Date(latest.at).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
          <div className="col" style={{ minHeight: 0 }}>
            {latest?.qualityNote && <div className="small text-warn">{latest.qualityNote}</div>}
            {latest ? (
              <>
                <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowText((v) => !v)}>
                  {showText ? 'Hide recognised text' : 'Show recognised text'}
                </button>
                {showText && (
                  <div className="ocr-text" data-testid="ocr-text">
                    {latest.quality === 'pending' ? 'Reading text…' : latest.ocrText || '(no text recognised)'}
                  </div>
                )}
              </>
            ) : (
              <div className="muted small">
                Capture your screen to let the assistant read slides, documents, code or tables. Use <b>Explain screen</b> to capture and explain in one step.
              </div>
            )}
          </div>
        </div>
      )}
      {picking && <SourcePicker onClose={() => setPicking(false)} />}
    </section>
  )
}
