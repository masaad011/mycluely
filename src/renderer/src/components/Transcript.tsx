import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranscriptSegment } from '@shared/types'
import { formatClock } from '@shared/util'
import { useStore } from '../lib/store'
import { IconWave } from './icons'

const Segment = memo(function Segment({ seg, isQuestion }: { seg: TranscriptSegment; isQuestion: boolean }): ReactNode {
  const cls = ['seg', isQuestion ? 'question' : '', seg.status === 'failed' ? 'failed' : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-testid="segment">
      <div className="time">{formatClock(seg.startMs)}</div>
      <div className={`who ${seg.source === 'mic' ? 'you' : 'remote'}`} title={seg.speaker}>
        {seg.speaker}
      </div>
      <div className="text">
        {seg.status === 'failed' ? `Couldn't transcribe this part${seg.error ? ` — ${seg.error}` : ''}` : seg.text}
      </div>
    </div>
  )
})

export function Transcript(): ReactNode {
  const segments = useStore((s) => s.segments) ?? []
  const questions = useStore((s) => s.questions) ?? []
  const session = useStore((s) => s.status.session)
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const questionSegs = new Set(questions.filter((q) => q.status !== 'dismissed').map((q) => q.segmentId))

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
      {segments.map((s) => (
        <Segment key={s.id} seg={s} isQuestion={questionSegs.has(s.id)} />
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
