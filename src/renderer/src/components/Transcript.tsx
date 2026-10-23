import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranscriptSegment } from '@shared/types'
import { formatClock } from '@shared/util'
import { useStore } from '../lib/store'
import { IconWave } from './icons'

/**
 * One transcript line. Consecutive lines from the same speaker are grouped (the name is shown on
 * the first), and lines where a question was detected are tagged as open or answered.
 */
export const SegmentRow = memo(function SegmentRow({
  seg,
  continued,
  question
}: {
  seg: TranscriptSegment
  /** Same speaker as the line before: the name is not repeated. */
  continued?: boolean
  question?: 'open' | 'answered'
}): ReactNode {
  const tone = seg.source === 'mic' ? 'you' : 'remote'
  const cls = ['seg', continued ? 'continued' : '', question ? `question ${question}` : '', seg.status === 'failed' ? 'failed' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} data-testid="segment" data-speaker={tone}>
      <div className="time">{formatClock(seg.startMs)}</div>
      <div className={`who ${tone}`} title={seg.speaker}>
        {continued ? <span className="sr-only">{seg.speaker}</span> : seg.speaker}
      </div>
      <div className="text">
        {seg.status === 'failed' ? `Couldn't transcribe this part${seg.error ? ` — ${seg.error}` : ''}` : seg.text}
        {question && (
          <span className={`q-tag ${question}`} data-testid="question-tag">
            {question === 'open' ? 'Question' : 'Answered'}
          </span>
        )}
      </div>
    </div>
  )
})

/** Whether `seg` continues the previous line's speaker (shown without repeating the name). */
export function continuesSpeaker(prev: TranscriptSegment | undefined, seg: TranscriptSegment): boolean {
  return !!prev && prev.speaker === seg.speaker && prev.status === 'ok' && seg.startMs - prev.startMs < 60_000
}

export function Transcript(): ReactNode {
  const segments = useStore((s) => s.segments) ?? []
  const questions = useStore((s) => s.questions) ?? []
  const session = useStore((s) => s.status.session)
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const questionSegs = new Map(questions.filter((q) => q.status !== 'dismissed').map((q) => [q.segmentId, q.status === 'open' ? 'open' : 'answered'] as const))

  useLayoutEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [segments, stick])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  if (!segments.length) {
    return (
      <div className="transcript" ref={ref}>
        <div className="empty">
          <IconWave />
          {session === 'running' ? (
            <>
              <div className="empty-title">Listening…</div>
              <div className="small">Speech from your microphone appears as “You”, meeting audio as “Remote”.</div>
            </>
          ) : session === 'paused' ? (
            <div className="empty-title">Capture is paused.</div>
          ) : (
            <>
              <div className="empty-title">No transcript yet</div>
              <div className="small">Press <b>Start meeting</b> to listen to your meeting.</div>
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="transcript" ref={ref} data-testid="transcript">
      {segments.map((s, i) => (
        <SegmentRow key={s.id} seg={s} continued={continuesSpeaker(segments[i - 1], s)} question={questionSegs.get(s.id)} />
      ))}
      {!stick && (
        <button
          className="btn sm jump"
          onClick={() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
            setStick(true)
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  )
}
