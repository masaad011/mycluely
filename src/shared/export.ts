import type { MeetingRecord } from './types'
import { ACTION_LABELS, MEETING_MODES } from './types'
import { formatClock, formatDuration } from './util'

function dateLabel(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function list(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '- None recorded'
}

export function meetingToMarkdown(m: MeetingRecord, opts: { includeScreens?: boolean } = {}): string {
  const mode = MEETING_MODES.find((x) => x.id === m.mode)?.label ?? m.mode
  const out: string[] = []
  out.push(`# ${m.title || 'Meeting'}`, '')
  out.push(`- **Date:** ${dateLabel(m.startedAt)}`)
  out.push(`- **Duration:** ${formatDuration(m.durationMs)}`)
  out.push(`- **Type:** ${mode}`)
  out.push(`- **AI model:** ${m.provider} / ${m.model}`)
  out.push('')

  if (m.summary) {
    out.push('## Summary', '', m.summary.overview || '_No overview._', '')
    out.push('### Key points', '', list(m.summary.keyPoints), '')
    out.push('### Decisions', '', list(m.summary.decisions), '')
    out.push('### Action items', '', m.summary.actionItems.length ? m.summary.actionItems.map((a) => `- [ ] ${a}`).join('\n') : '- None recorded', '')
    out.push('### Open questions', '', list(m.summary.openQuestions), '')
  }

  const questions = m.questions.filter((q) => q.status !== 'dismissed')
  if (questions.length) {
    out.push('## Questions detected', '')
    for (const q of questions) out.push(`- ${q.status === 'answered' ? '✅' : '❔'} ${q.speaker}: ${q.text}`)
    out.push('')
  }

  out.push('## Transcript', '')
  const segs = m.segments.filter((s) => s.status === 'ok' && s.text.trim())
  if (!segs.length) out.push('_No transcript._')
  for (const s of segs) out.push(`**[${formatClock(s.startMs)}] ${s.speaker}:** ${s.text.trim()}  `)
  out.push('')

  const responses = m.responses.filter((r) => r.status === 'done' && r.text.trim())
  if (responses.length) {
    out.push('## Assistant responses', '')
    for (const r of responses) {
      const when = m.startedAt ? formatClock(r.at - m.startedAt) : ''
      out.push(`### ${when ? `[${when}] ` : ''}${ACTION_LABELS[r.action]}${r.prompt ? ` — “${r.prompt}”` : ''}`, '')
      out.push(r.text.trim(), '')
    }
  }

  if (opts.includeScreens && m.snapshots.length) {
    out.push('## Screen captures (OCR text)', '')
    for (const s of m.snapshots) {
      const when = m.startedAt ? formatClock(s.at - m.startedAt) : ''
      out.push(`### [${when}] ${s.sourceName} — ${s.quality}`, '')
      out.push('```text', s.ocrText.trim() || '(no text)', '```', '')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function meetingToText(m: MeetingRecord): string {
  const mode = MEETING_MODES.find((x) => x.id === m.mode)?.label ?? m.mode
  const out: string[] = []
  out.push(m.title || 'Meeting')
  out.push('='.repeat(Math.min(60, (m.title || 'Meeting').length)))
  out.push(`Date: ${dateLabel(m.startedAt)}`, `Duration: ${formatDuration(m.durationMs)}`, `Type: ${mode}`, '')
  if (m.summary) {
    out.push('SUMMARY', m.summary.overview, '')
    const sec = (title: string, items: string[]): void => {
      out.push(title)
      out.push(...(items.length ? items.map((i) => `  * ${i}`) : ['  (none)']))
      out.push('')
    }
    sec('KEY POINTS', m.summary.keyPoints)
    sec('DECISIONS', m.summary.decisions)
    sec('ACTION ITEMS', m.summary.actionItems)
    sec('OPEN QUESTIONS', m.summary.openQuestions)
  }
  out.push('TRANSCRIPT')
  for (const s of m.segments.filter((x) => x.status === 'ok' && x.text.trim())) {
    out.push(`[${formatClock(s.startMs)}] ${s.speaker}: ${s.text.trim()}`)
  }
  out.push('')
  const responses = m.responses.filter((r) => r.status === 'done' && r.text.trim())
  if (responses.length) {
    out.push('ASSISTANT RESPONSES')
    for (const r of responses) {
      out.push(`--- ${ACTION_LABELS[r.action]}${r.prompt ? `: ${r.prompt}` : ''}`)
      out.push(r.text.trim(), '')
    }
  }
  return out.join('\n').trim() + '\n'
}
