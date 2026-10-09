import { useEffect, useState, type ReactNode } from 'react'
import type { MeetingMode } from '@shared/types'
import { MEETING_MODES, RESPONSE_STYLES } from '@shared/types'
import { formatClock } from '@shared/util'
import { api } from '../lib/api'
import { safe, startMeeting } from '../lib/actions'
import { useStore } from '../lib/store'
import { ActionGrid, AnswerModeBar, AskBox, QuestionChips, ResponseCard } from '../components/Assistant'
import { ConsentHost, confirmConsent } from '../components/Consent'
import { Segmented, Toasts, useElapsed } from '../components/common'
import { IconBot, IconHistory, IconLive, IconPanel, IconPause, IconPlay, IconSettings, IconStop, IconWave } from '../components/icons'
import { ScreenPanel } from '../components/ScreenPanel'
import { StatusBar } from '../components/StatusBar'
import { Transcript } from '../components/Transcript'
import { HistoryView } from './History'
import { SettingsView } from './Settings'
import logo from '../../../../resources/icon.png'

type View = 'live' | 'history' | 'settings'

function TopBar(): ReactNode {
  const status = useStore((s) => s.status)
  const [title, setTitle] = useState('')
  const live0 = status?.session === 'running' || status?.session === 'paused'
  // While live the field edits the meeting title; when idle it names the next meeting.
  useEffect(() => setTitle(live0 ? (status?.meetingTitle ?? '') : ''), [live0, status?.meetingTitle])
  const elapsed = useElapsed(status?.startedAt, status?.session === 'running' || status?.session === 'paused')
  if (!status) return null
  const s = status.session
  const live = s === 'running' || s === 'paused'
  return (
    <header className="topbar">
      <input
        className="title-input"
        value={title}
        placeholder={live ? 'Meeting title' : 'New meeting'}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => live && title.trim() && title !== status.meetingTitle && void safe(() => api.invoke('session:rename', title))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Meeting title"
      />
      {live && (
        <span className={`rec-pill${s === 'paused' ? ' paused' : ''}`} data-testid="rec-pill">
          <span className={`dot ${s === 'running' ? 'rec' : 'warn'}`} />
          {s === 'running' ? 'Recording' : 'Paused'}
          <span className="timer">{formatClock(elapsed)}</span>
        </span>
      )}
      {!live && s === 'idle' && status.meetingTitle && (
        <span className="small muted ellipsis" style={{ maxWidth: 320 }} title="The transcript below is from your last meeting; it is in History.">
          Last: {status.meetingTitle}
        </span>
      )}
      {s === 'stopping' && <span className="badge">Finishing… writing summary</span>}
      <span className="spacer" />
      <select
        value={status.mode}
        onChange={(e) => {
          const mode = e.target.value as MeetingMode
          void safe(async () => {
            if (live) await api.invoke('session:set-mode', mode)
            else await api.invoke('settings:update', { assistant: { mode } })
          })
        }}
        aria-label="Meeting type"
        title="Meeting type tailors how the assistant answers"
      >
        {MEETING_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => void api.invoke('window:toggle-overlay')} title="Show / hide the floating assistant panel">
        <IconPanel /> Panel
      </button>
      <span className="topbar-sep" />
      {!live ? (
        <button
          className="btn rec"
          disabled={s !== 'idle'}
          onClick={() => void startMeeting(confirmConsent, { title: title.trim() || undefined })}
          data-testid="start"
        >
          <IconPlay /> Start meeting
        </button>
      ) : (
        <>
          {s === 'running' ? (
            <button className="btn" onClick={() => void safe(() => api.invoke('session:pause'))} data-testid="pause">
              <IconPause /> Pause
            </button>
          ) : (
            <button className="btn primary" onClick={() => void safe(() => api.invoke('session:resume'))} data-testid="resume">
              <IconPlay /> Resume
            </button>
          )}
          <button className="btn danger" onClick={() => void safe(() => api.invoke('session:stop'))} data-testid="stop">
            <IconStop /> Stop
          </button>
        </>
      )}
    </header>
  )
}

function AssistantPane(): ReactNode {
  const responses = useStore((s) => s.responses) ?? []
  const style = useStore((s) => s.settings.assistant.style)
  const configured = useStore((s) => s.status.ai.configured)
  const auto = useStore((s) => s.settings?.assistant.autoSuggest) === 'answers'
  const ordered = responses.slice().reverse()
  return (
    <div className="right">
      <div className="pane-head">
        <IconBot />
        <h2>Assistant</h2>
        <span className="spacer" />
        <Segmented
          title="Response style"
          value={style ?? 'short'}
          options={RESPONSE_STYLES}
          onChange={(v) => void safe(() => api.invoke('settings:update', { assistant: { style: v } }))}
        />
      </div>
      <ActionGrid />
      <AnswerModeBar />
      <QuestionChips />
      {!configured && (
        <div className="callout warn" style={{ margin: '0 16px 10px' }}>
          No API key for the selected AI provider.{' '}
          <button className="link" onClick={() => void api.invoke('window:show-main', 'settings')}>
            Add one in Settings
          </button>{' '}
          — transcription and screen reading still work without it.
        </div>
      )}
      <div className="responses" data-testid="responses">
        {ordered.length === 0 ? (
          <div className="empty">
            <div className="empty-title">Answers, suggestions and explanations appear here.</div>
            <div className="small">
              {auto
                ? 'Auto mode: questions asked by other participants or shown on the watched screen are answered as soon as they appear.'
                : 'Use the buttons above, the global shortcuts, or ask anything below. Switch Answer mode to Auto to answer automatically.'}
            </div>
          </div>
        ) : (
          ordered.map((r) => <ResponseCard key={r.id} r={r} />)
        )}
      </div>
      <AskBox autoFocusEvent />
    </div>
  )
}

function LiveView(): ReactNode {
  const lines = useStore((s) => s.segments?.length) ?? 0
  return (
    <div className="live">
      <div className="left">
        <div className="pane-head">
          <IconWave />
          <h2>Transcript</h2>
          {lines > 0 && <span className="count">{lines} {lines === 1 ? 'line' : 'lines'}</span>}
        </div>
        <Transcript />
        <ScreenPanel />
      </div>
      <AssistantPane />
    </div>
  )
}

export function App(): ReactNode {
  const loaded = useStore((s) => s.loaded)
  const [view, setView] = useState<View>('live')
  useEffect(() => api.on('navigate', (v) => setView(v)), [])
  if (!loaded) return <div className="empty">Loading…</div>
  const nav: { id: View; label: string; icon: ReactNode }[] = [
    { id: 'live', label: 'Live', icon: <IconLive /> },
    { id: 'history', label: 'History', icon: <IconHistory /> },
    { id: 'settings', label: 'Settings', icon: <IconSettings /> }
  ]
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <img className="logo" src={logo} alt="MyCluely" />
        {nav.map((n) => (
          <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => setView(n.id)} data-testid={`nav-${n.id}`}>
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
      <main className="main">
        <TopBar />
        <StatusBar />
        {view === 'live' && <LiveView />}
        {view === 'history' && <HistoryView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <Toasts />
      <ConsentHost />
    </div>
  )
}
