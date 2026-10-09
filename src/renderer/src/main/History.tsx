import { useEffect, useState, type ReactNode } from 'react'
import type { MeetingRecord, MeetingRecordMeta } from '@shared/types'
import { ACTION_LABELS, MEETING_MODES } from '@shared/types'
import { formatClock, formatDuration } from '@shared/util'
import { api } from '../lib/api'
import { safe } from '../lib/actions'
import { Markdown } from '../lib/markdown'
import { pushToast, useStore } from '../lib/store'
import { Modal, Splitter } from '../components/common'
import { useLayout, useLayoutValue } from '../components/Panels'
import { DEFAULT_LAYOUT, updateLayout } from '../lib/layout'
import { IconDownload, IconHistory, IconTrash } from '../components/icons'

function SummaryBlock({ m }: { m: MeetingRecord }): ReactNode {
  if (!m.summary) return <div className="callout">No summary was generated for this meeting.</div>
  const s = m.summary
  const list = (items: string[]): ReactNode => (items.length ? <ul>{items.map((i, k) => <li key={k}>{i}</li>)}</ul> : <div className="muted small">None recorded</div>)
  return (
    <>
      {s.overview && <p>{s.overview}</p>}
      <div className="summary-grid">
        <div className="card">
          <h4>Key points</h4>
          {list(s.keyPoints)}
        </div>
        <div className="card">
          <h4>Decisions</h4>
          {list(s.decisions)}
        </div>
        <div className="card">
          <h4>Action items</h4>
          {list(s.actionItems)}
        </div>
        <div className="card">
          <h4>Open questions</h4>
          {list(s.openQuestions)}
        </div>
      </div>
    </>
  )
}

export function HistoryView(): ReactNode {
  const [items, setItems] = useState<MeetingRecordMeta[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<MeetingRecord | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript' | 'responses'>('summary')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const saveHistory = useStore((s) => s.settings.privacy.saveHistory)
  const layout = useLayout()
  const [width, previewWidth, commitWidth] = useLayoutValue(layout.historyWidth, (v) => updateLayout({ historyWidth: v }))
  const session = useStore((s) => s.status.session)

  const load = async (): Promise<void> => {
    const list = (await safe(() => api.invoke('history:list'))) ?? []
    setItems(list)
    if (!selected && list[0]) setSelected(list[0].id)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])
  useEffect(() => {
    if (!selected) return setDetail(null)
    let current = true
    void safe(() => api.invoke('history:get', selected)).then((d) => current && setDetail(d ?? null))
    return () => {
      current = false
    }
  }, [selected])

  const exportAs = async (format: 'md' | 'txt'): Promise<void> => {
    if (!detail) return
    const path = await safe(() => api.invoke('history:export', detail.id, format), 'Export failed')
    if (path) pushToast({ id: String(Date.now()), level: 'success', message: 'Exported', detail: path, at: Date.now() })
  }

  return (
    <div className="history" style={{ gridTemplateColumns: `${width}px 1px 1fr` }}>
      <div className="history-list" aria-label="Saved meetings">
        {!saveHistory && <div className="callout small" style={{ margin: 6 }}>History is turned off in Settings → Privacy. New meetings are not saved.</div>}
        {items === null ? (
          <div className="muted small" style={{ padding: 12 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty">
            <IconHistory />
            <div className="empty-title">No saved meetings yet</div>
          </div>
        ) : (
          items.map((m) => (
            <div key={m.id} className={`history-item${selected === m.id ? ' active' : ''}`} onClick={() => setSelected(m.id)} role="button" tabIndex={0}>
              <span className="ellipsis title">{m.title}</span>
              <span className="small muted">
                {new Date(m.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {formatDuration(m.durationMs)}
              </span>
              <span className="row tiny muted">
                {MEETING_MODES.find((x) => x.id === m.mode)?.label} · {m.segmentCount} lines {m.hasSummary && <span className="badge ok">summary</span>}
              </span>
            </div>
          ))
        )}
      </div>
      <Splitter
        orientation="vertical"
        unit="px"
        label="Resize the meeting list"
        value={width}
        min={220}
        max={640}
        onChange={previewWidth}
        onCommit={(v) => commitWidth(Math.round(v))}
        onReset={() => commitWidth(DEFAULT_LAYOUT.historyWidth)}
      />
      <div className="history-detail">
        {!detail ? (
          <div className="empty">Select a meeting to see its summary and transcript.</div>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <h1>{detail.title}</h1>
                <div className="muted small">
                  {new Date(detail.startedAt).toLocaleString()} · {formatDuration(detail.durationMs)} · {MEETING_MODES.find((x) => x.id === detail.mode)?.label} · {detail.provider}/{detail.model}
                </div>
              </div>
              <button className="btn" onClick={() => void exportAs('md')}>
                <IconDownload /> Markdown
              </button>
              <button className="btn" onClick={() => void exportAs('txt')}>
                <IconDownload /> Text
              </button>
              <button className="btn danger icon" title="Delete meeting" onClick={() => setConfirmDelete(true)}>
                <IconTrash />
              </button>
            </div>
            <div className="segmented" style={{ margin: '16px 0 8px' }}>
              {(['summary', 'transcript', 'responses'] as const).map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                  {t === 'summary' ? 'Summary' : t === 'transcript' ? `Transcript (${detail.segments.length})` : `AI responses (${detail.responses.filter((r) => r.status === 'done').length})`}
                </button>
              ))}
            </div>
            {tab === 'summary' && <SummaryBlock m={detail} />}
            {tab === 'transcript' && (
              <div>
                {detail.segments.filter((s) => s.status === 'ok').map((s) => (
                  <div key={s.id} className="seg">
                    <div className="time">{formatClock(s.startMs)}</div>
                    <div className={`who ${s.source === 'mic' ? 'you' : 'remote'}`} title={s.speaker}>
                      {s.speaker}
                    </div>
                    <div className="text">{s.text}</div>
                  </div>
                ))}
                {!detail.segments.length && <div className="muted">No transcript.</div>}
              </div>
            )}
            {tab === 'responses' && (
              <div className="col" style={{ gap: 10 }}>
                {detail.responses
                  .filter((r) => r.status === 'done')
                  .map((r) => (
                    <div key={r.id} className="resp">
                      <div className="resp-head">
                        <span className="kind">{r.action === 'ask' && r.prompt ? `“${r.prompt}”` : ACTION_LABELS[r.action]}</span>
                        <span className="spacer" />
                        <span>{formatClock(r.at - detail.startedAt)}</span>
                      </div>
                      <Markdown text={r.text} />
                    </div>
                  ))}
                {!detail.responses.length && <div className="muted">No AI responses.</div>}
              </div>
            )}
          </>
        )}
      </div>
      {confirmDelete && detail && (
        <Modal
          title="Delete this meeting?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  setConfirmDelete(false)
                  await safe(() => api.invoke('history:delete', detail.id))
                  setSelected(null)
                  void load()
                }}
              >
                Delete
              </button>
            </>
          }
        >
          “{detail.title}” and its transcript will be permanently deleted.
        </Modal>
      )}
    </div>
  )
}
