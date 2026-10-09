import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RESPONSE_STYLES } from '@shared/types'
import { formatClock } from '@shared/util'
import { api } from '../lib/api'
import { safe, startMeeting } from '../lib/actions'
import { useStore } from '../lib/store'
import { ActionGrid, AnswerModeBar, AskBox, QuestionChips, ResponseCard } from '../components/Assistant'
import { ConsentHost, confirmConsent } from '../components/Consent'
import { accelLabel, Meter, Segmented, Toasts, useElapsed } from '../components/common'
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconLive, IconPause, IconPin, IconPlay, IconX } from '../components/icons'
import { ModelSwitcher } from '../components/StatusBar'
import logo from '../../../../resources/icon.png'

/** Compact always-on-top assistant panel for use during a meeting. */
export function OverlayApp(): ReactNode {
  const loaded = useStore((s) => s.loaded)
  const status = useStore((s) => s.status)
  const levels = useStore((s) => s.levels)
  const responses = useStore((s) => s.responses) ?? []
  const settings = useStore((s) => s.settings)
  const platform = useStore((s) => s.platform)
  const [index, setIndex] = useState<number | null>(null) // null = follow latest
  const elapsed = useElapsed(status?.startedAt, status?.session === 'running' || status?.session === 'paused')
  // Collapsed: the window shrinks to its title bar; answers arriving meanwhile are flagged.
  const headRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [seen, setSeen] = useState(0)
  const setPanelCollapsed = async (collapse: boolean): Promise<void> => {
    const bar = Math.ceil((headRef.current?.getBoundingClientRect().height ?? 42) + 2) // + the window border
    const state = await safe(() => api.invoke('window:overlay-collapse', collapse, bar))
    if (state === undefined) return
    setCollapsed(state)
    setSeen(responses.length)
  }

  // Jump to the newest answer whenever a new one starts.
  useEffect(() => setIndex(null), [responses.length])

  if (!loaded || !status || !settings || !levels) return <div className="overlay" />
  const s = status.session
  const live = s === 'running' || s === 'paused'
  const current = index === null ? responses.length - 1 : index
  const r = responses[current]
  const onTop = settings.ui.overlayAlwaysOnTop

  return (
    <div className={`overlay${collapsed ? ' collapsed' : ''}`}>
      <div className="ov-head" ref={headRef}>
        <span className="brand">
          <img src={logo} alt="" />
          MyCluely
        </span>
        {live ? (
          <span className="row small" style={{ gap: 6 }}>
            <span className={`dot ${s === 'running' ? 'rec' : 'warn'}`} />
            <span className="dim" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatClock(elapsed)}</span>
            <Meter level={levels.mic} speaking={levels.micSpeaking} active={s === 'running' && status.mic.active} />
            <Meter level={levels.system} speaking={levels.systemSpeaking} active={s === 'running' && status.system.active} />
          </span>
        ) : (
          <span className="small muted">idle</span>
        )}
        {collapsed && responses.length > seen && (
          <button className="badge accent new-answer" onClick={() => void setPanelCollapsed(false)} title="Show the new answer" data-testid="new-answer">
            New answer
          </button>
        )}
        <span className="spacer" />
        {live ? (
          <button
            className="btn ghost sm icon"
            title={s === 'running' ? 'Pause capture' : 'Resume capture'}
            onClick={() => void safe(() => api.invoke(s === 'running' ? 'session:pause' : 'session:resume'))}
          >
            {s === 'running' ? <IconPause /> : <IconPlay />}
          </button>
        ) : (
          <button
            className="btn sm rec"
            onClick={async () => {
              if (collapsed) await setPanelCollapsed(false) // room for the consent reminder
              await startMeeting(confirmConsent)
            }}
            disabled={s !== 'idle'}
            title="Start listening"
          >
            <IconPlay /> Start
          </button>
        )}
        <button
          className={`btn ghost sm icon${onTop ? ' pinned' : ''}`}
          title={onTop ? 'Unpin (allow other windows on top)' : 'Pin on top'}
          onClick={() => void safe(() => api.invoke('window:set-overlay-top', !onTop))}
        >
          <IconPin />
        </button>
        <button className="btn ghost sm icon" title="Open main window" onClick={() => void api.invoke('window:show-main', 'live')}>
          <IconLive />
        </button>
        <button
          className="btn ghost sm icon"
          title={collapsed ? 'Expand the panel' : 'Collapse to the title bar'}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-expanded={!collapsed}
          onClick={() => void setPanelCollapsed(!collapsed)}
          data-testid="overlay-collapse"
        >
          {collapsed ? <IconChevronDown /> : <IconChevronUp />}
        </button>
        <button className="btn ghost sm icon" title="Hide panel" onClick={() => void api.invoke('window:hide-overlay')}>
          <IconX />
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="ov-tools">
            <Segmented
              title="Response style"
              value={settings.assistant.style}
              options={RESPONSE_STYLES}
              onChange={(v) => void safe(() => api.invoke('settings:update', { assistant: { style: v } }))}
            />
            <span className="spacer" />
            <ModelSwitcher compact />
          </div>
          <AnswerModeBar compact />
          <div className="ov-body">
            <QuestionChips limit={2} />
            {r ? (
              <>
                {responses.length > 1 && (
                  <div className="ov-nav">
                    <button className="btn ghost sm icon" disabled={current <= 0} onClick={() => setIndex(Math.max(0, current - 1))} aria-label="Previous answer">
                      <IconChevronLeft />
                    </button>
                    <span>
                      {current + 1} / {responses.length}
                    </span>
                    <button
                      className="btn ghost sm icon"
                      disabled={current >= responses.length - 1}
                      onClick={() => setIndex(current + 1 >= responses.length - 1 ? null : current + 1)}
                      aria-label="Next answer"
                    >
                      <IconChevronRight />
                    </button>
                  </div>
                )}
                <ResponseCard r={r} compact />
              </>
            ) : (
              <div className="ov-idle">
                <div className="empty-title">{status.ai.configured ? 'Ready when you are.' : 'Add an API key in Settings to get answers.'}</div>
                <div className="col small" style={{ gap: 4 }}>
                  <span>
                    <kbd>{accelLabel(settings.shortcuts.answer, platform)}</kbd> answer the latest question
                  </span>
                  <span>
                    <kbd>{accelLabel(settings.shortcuts.explainScreen, platform)}</kbd> explain the screen
                  </span>
                  <span>
                    <kbd>{accelLabel(settings.shortcuts.toggleOverlay, platform)}</kbd> show / hide this panel
                  </span>
                </div>
              </div>
            )}
          </div>
          <ActionGrid compact />
          <AskBox compact autoFocusEvent />
        </>
      )}
      <Toasts />
      <ConsentHost />
    </div>
  )
}
