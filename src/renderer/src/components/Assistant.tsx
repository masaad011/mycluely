import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { parseSuggestedQuestions, type SuggestedQuestion } from '@shared/suggestions'
import type { AssistantAction, AssistantResponse, DetectedQuestion, ScreenWatchState } from '@shared/types'
import { ACTION_LABELS, PROVIDER_LABELS } from '@shared/types'
import { api } from '../lib/api'
import { copyText, runAction, safe } from '../lib/actions'
import { Markdown, markdownToPlain } from '../lib/markdown'
import { useStore } from '../lib/store'
import { accelLabel, Segmented } from './common'
import {
  IconAlert,
  IconAnswer,
  IconCopy,
  IconCrop,
  IconMonitor,
  IconPause,
  IconPlay,
  IconQuestion,
  IconRefresh,
  IconScreenExplain,
  IconSend,
  IconStop,
  IconSummary,
  IconWand,
  IconX
} from './icons'
import { SourcePicker } from './ScreenPanel'

export const PRIMARY_ACTIONS: { action: AssistantAction; short: string; icon: (p: object) => ReactNode; shortcut: string }[] = [
  { action: 'answer', short: 'Answer', icon: IconAnswer, shortcut: 'answer' },
  { action: 'suggest', short: 'Questions to ask', icon: IconQuestion, shortcut: 'suggest' },
  { action: 'explain-screen', short: 'Explain screen', icon: IconScreenExplain, shortcut: 'explainScreen' },
  { action: 'summarize', short: 'Summarize', icon: IconSummary, shortcut: 'summarize' }
]

const WATCH_TEXT: Record<ScreenWatchState, string> = {
  off: 'Answering spoken questions automatically',
  waiting: 'Starts when the meeting starts',
  'no-source': 'Choose a screen, window or region to watch',
  paused: 'Paused — nothing is answered automatically',
  watching: 'Watching',
  settling: 'Screen changed — waiting for it to settle…',
  reading: 'Reading the screen…',
  answering: 'Answering…',
  nothing: 'Nothing new to answer',
  unreadable: 'Can’t read the screen'
}

/**
 * Answer mode: Manual (answers only on click or shortcut) or Auto (answers spoken questions and,
 * when enabled, questions shown on the watched screen, window or region). In Auto mode it shows
 * what the watcher is doing, with pause/resume and the choice of what to watch.
 */
export function AnswerModeBar({ compact }: { compact?: boolean }): ReactNode {
  const auto = useStore((s) => s.settings?.assistant.autoSuggest) === 'answers'
  const watchScreen = useStore((s) => s.settings?.assistant.autoScreen)
  const shortcut = useStore((s) => s.settings?.shortcuts.answer)
  const platform = useStore((s) => s.platform)
  const status = useStore((s) => s.status?.autoAnswer)
  const screen = useStore((s) => s.status?.screen)
  const [picking, setPicking] = useState(false)
  if (!status || !screen) return null
  const state: ScreenWatchState = status.paused ? 'paused' : status.screen
  const where = `${screen.sourceName ?? 'the screen'}${screen.region ? ' (region)' : ''}`
  const text = !auto
    ? `Answers only when you click Answer${shortcut ? ` or press ${accelLabel(shortcut, platform)}` : ''}`
    : !watchScreen && !status.paused
      ? 'Answering spoken questions automatically (screen watching is off in Settings)'
      : state === 'watching'
        ? `Watching ${where} and listening for questions`
        : state === 'nothing'
          ? `Watching ${where} — nothing new to answer`
        : state === 'unreadable' && status.detail
          ? `${WATCH_TEXT.unreadable}: ${status.detail}`
          : WATCH_TEXT[state]
  const tone = !auto ? '' : state === 'paused' ? 'paused' : state === 'unreadable' ? 'warn' : state === 'off' ? '' : 'live'
  return (
    <div className={`answer-mode${compact ? ' compact' : ''}`} data-testid="answer-mode">
      <Segmented
        title="Answer mode"
        value={auto ? 'auto' : 'manual'}
        options={[
          { id: 'manual', label: 'Manual' },
          { id: 'auto', label: 'Auto' }
        ]}
        onChange={(v) => void safe(() => api.invoke('settings:update', { assistant: { autoSuggest: v === 'auto' ? 'answers' : 'questions' } }))}
      />
      <span className={`am-status ${tone}`} title={status.detail ?? text} data-testid="auto-status" data-state={auto ? state : 'manual'}>
        {tone && <span className="am-dot" />}
        <span className="ellipsis">{text}</span>
      </span>
      {auto && (
        <span className="row" style={{ gap: 2 }}>
          <button
            className="btn ghost sm"
            onClick={() => void safe(() => api.invoke('auto:set-paused', !status.paused))}
            title={status.paused ? 'Resume automatic answering' : 'Pause automatic answering'}
            data-testid="auto-pause"
          >
            {status.paused ? <IconPlay /> : <IconPause />} {!compact && (status.paused ? 'Resume' : 'Pause')}
          </button>
          {watchScreen && (
            <>
              {!compact && (
                <button className="btn ghost sm" onClick={() => setPicking(true)} title="Choose the screen or window to watch">
                  <IconMonitor /> Area
                </button>
              )}
              <button className="btn ghost sm" onClick={() => void safe(() => api.invoke('screen:select-region'))} title="Watch only part of a screen">
                <IconCrop /> {!compact && 'Region'}
              </button>
            </>
          )}
        </span>
      )}
      {picking && <SourcePicker onClose={() => setPicking(false)} />}
    </div>
  )
}

export function ActionGrid({ compact }: { compact?: boolean }): ReactNode {
  const shortcuts = useStore((s) => s.settings.shortcuts)
  const platform = useStore((s) => s.platform)
  const auto = useStore((s) => s.settings?.assistant.autoSuggest) === 'answers'
  if (compact) {
    return (
      <div className="ov-actions">
        {PRIMARY_ACTIONS.map((a) => (
          <button
            key={a.action}
            className="btn"
            title={`${ACTION_LABELS[a.action]} (${accelLabel(shortcuts?.[a.shortcut as keyof typeof shortcuts], platform)})`}
            onClick={() => void runAction(a.action)}
            data-testid={`action-${a.action}`}
          >
            <a.icon />
            {a.short.split(' ')[0]}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="actions">
      {PRIMARY_ACTIONS.map((a) => (
        <button
          key={a.action}
          className="action-btn"
          title={ACTION_LABELS[a.action]}
          onClick={() => void runAction(a.action)}
          data-testid={`action-${a.action}`}
        >
          <span className="icon-tile">
            <a.icon />
          </span>
          <span className="action-text">
            <span className="label">{a.short}</span>
            <span className="hint">
              {a.action === 'answer' && auto ? 'Automatic · ' : ''}
              {accelLabel(shortcuts?.[a.shortcut as keyof typeof shortcuts], platform)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function QuestionChips({ limit = 3 }: { limit?: number }): ReactNode {
  const questions = useStore((s) => s.questions) ?? []
  const open = questions.filter((q) => q.status === 'open').slice(-limit).reverse()
  if (!open.length) return null
  return (
    <div className="questions" data-testid="questions">
      {open.map((q: DetectedQuestion) => (
        <span key={q.id} className="qchip" title={`${q.speaker}: ${q.text}`}>
          <IconQuestion />
          <span className="q">{q.text}</span>
          <button onClick={() => void runAction('answer', { questionId: q.id })}>Answer</button>
          <button className="x" aria-label="Dismiss question" onClick={() => void safe(() => api.invoke('questions:dismiss', q.id))}>
            <IconX width={12} height={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

const REFINEMENTS = [
  { label: 'Shorter', instruction: 'Make it shorter and punchier.' },
  { label: 'More detail', instruction: 'Add more detail and concrete specifics.' },
  { label: 'Simpler', instruction: 'Explain it more simply, without jargon.' },
  { label: 'More formal', instruction: 'Make it more formal and professional.' }
]

function seconds(ms: number): string {
  if (ms < 100) return '<0.1 s'
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** "Questions to ask": one row per suggested question, each with its own copy button. */
function QuestionList({ items }: { items: SuggestedQuestion[] }): ReactNode {
  return (
    <ol className="suggestions" data-testid="suggestions">
      {items.map((it, i) => (
        <li key={i} className="suggestion" data-testid="suggestion">
          <IconQuestion className="sq-icon" />
          <div className="grow">
            <div className="sq">{it.question}</div>
            {it.reason && <div className="sq-reason">{it.reason}</div>}
          </div>
          <button className="btn ghost sm icon" title="Copy this question" aria-label={`Copy question ${i + 1}`} onClick={() => void copyText(it.question)}>
            <IconCopy />
          </button>
        </li>
      ))}
    </ol>
  )
}

export const ResponseCard = memo(function ResponseCard({ r, compact }: { r: AssistantResponse; compact?: boolean }): ReactNode {
  const [refining, setRefining] = useState(false)
  const [custom, setCustom] = useState('')
  const streaming = r.status === 'streaming'
  const question = useStore((s) => (r.questionId ? s.questions.find((q) => q.id === r.questionId)?.text : undefined))
  // Suggested questions (and refinements of them) are shown as a list of copyable questions.
  const parentAction = useStore((s) => (r.parentId ? s.responses.find((x) => x.id === r.parentId)?.action : undefined))
  const questionList = r.action === 'suggest' || (r.action === 'refine' && parentAction === 'suggest')
  const items = questionList && r.status !== 'error' ? parseSuggestedQuestions(r.text) : []
  const title =
    r.action === 'ask' && r.prompt
      ? `“${r.prompt}”`
      : r.action === 'refine'
        ? `Refined: ${r.prompt ?? ''}`
        : r.action === 'answer' && question
          ? `Answer: “${question}”`
          : ACTION_LABELS[r.action]
  return (
    <article className={`resp ${r.status}`} data-testid="response" data-status={r.status}>
      <div className="resp-head">
        <span className="kind ellipsis grow" title={title}>
          {r.auto && <span className="badge accent" style={{ marginRight: 6 }}>auto</span>}
          {title}
        </span>
        <span
          className="meta ellipsis"
          title={[
            `${PROVIDER_LABELS[r.provider]} · ${r.model}`,
            r.firstTokenMs !== undefined && `First words after ${seconds(r.firstTokenMs)}`,
            r.totalMs !== undefined && `Complete after ${seconds(r.totalMs)}`
          ]
            .filter(Boolean)
            .join('\n')}
          data-testid="response-meta"
        >
          {!compact && `${r.model} · `}
          {r.firstTokenMs !== undefined && `${seconds(r.firstTokenMs)} · `}
          {new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className={`resp-body${streaming ? ' typing' : ''}`}>
        {items.length ? <QuestionList items={items} /> : r.text ? <Markdown text={r.text} /> : streaming ? <span className="muted">Thinking…</span> : null}
        {r.status === 'error' && (
          <div className="row resp-error">
            <IconAlert style={{ flex: 'none', marginTop: 3 }} />
            <span>{r.error}</span>
          </div>
        )}
        {r.status === 'cancelled' && <div className="muted small">Stopped.</div>}
      </div>
      {!!r.notes?.length && (
        <div className="resp-notes">
          {r.notes.map((n, i) => (
            <div key={i}>
              <IconAlert width={13} height={13} style={{ flex: 'none', marginTop: 2 }} />
              {n}
            </div>
          ))}
        </div>
      )}
      <div className="resp-foot">
        {streaming ? (
          <button key="stop" className="btn sm" onClick={() => void safe(() => api.invoke('assistant:cancel', r.id))}>
            <IconStop /> Stop
          </button>
        ) : (
          <>
            {/* Distinct keys: reusing the Stop button's element would animate it into the Copy button. */}
            <button
              key="copy"
              className="btn ghost sm"
              disabled={!r.text}
              onClick={() => void copyText(items.length ? items.map((it) => it.question).join('\n') : markdownToPlain(r.text))}
              title={items.length ? 'Copy all questions' : 'Copy'}
            >
              <IconCopy /> {!compact && (items.length ? 'Copy all' : 'Copy')}
            </button>
            {r.action === 'suggest' ? (
              <button className="btn ghost sm" onClick={() => void runAction('suggest')} title="Suggest different questions" data-testid="more-questions">
                <IconRefresh /> More questions
              </button>
            ) : (
              <button className="btn ghost sm" onClick={() => void safe(() => api.invoke('assistant:regenerate', r.id))} title="Regenerate">
                <IconRefresh /> {!compact && 'Regenerate'}
              </button>
            )}
            {r.status === 'done' && (
              <button className="btn ghost sm" onClick={() => setRefining((v) => !v)} title="Refine">
                <IconWand /> Refine
              </button>
            )}
          </>
        )}
      </div>
      {refining && !streaming && (
        <div className="col" style={{ marginTop: 8 }}>
          <div className="row wrap">
            {REFINEMENTS.map((x) => (
              <button
                key={x.label}
                className="btn sm"
                onClick={() => {
                  setRefining(false)
                  void safe(() => api.invoke('assistant:refine', r.id, x.instruction))
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              if (!custom.trim()) return
              setRefining(false)
              void safe(() => api.invoke('assistant:refine', r.id, custom.trim()))
              setCustom('')
            }}
          >
            <input type="text" className="grow" placeholder="Or describe the change…" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn sm" type="submit">Apply</button>
          </form>
        </div>
      )}
    </article>
  )
})

export function AskBox({ compact, autoFocusEvent }: { compact?: boolean; autoFocusEvent?: boolean }): ReactNode {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocusEvent) return
    return api.on('focus-ask', () => ref.current?.focus())
  }, [autoFocusEvent])
  const submit = (): void => {
    const q = text.trim()
    if (!q) return
    setText('')
    void runAction('ask', { prompt: q })
  }
  if (compact) {
    return (
      <form
        className="ov-ask"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input ref={ref} type="text" placeholder="Ask anything about the meeting…" value={text} onChange={(e) => setText(e.target.value)} data-testid="ask-input" />
        <button className="btn primary icon" type="submit" aria-label="Ask" disabled={!text.trim()}>
          <IconSend />
        </button>
      </form>
    )
  }
  return (
    <div className="askbox">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          placeholder="Ask anything about the meeting…  (Enter to send · Shift+Enter for a new line)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          data-testid="ask-input"
        />
        <button className="btn primary" onClick={submit} disabled={!text.trim()}>
          <IconSend /> Ask
        </button>
      </div>
    </div>
  )
}
