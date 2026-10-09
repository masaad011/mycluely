import type { MeetingSummary } from './types'

const SECTION_KEYS: Record<string, keyof Omit<MeetingSummary, 'overview' | 'updatedAt' | 'markdown'> | 'overview'> = {
  overview: 'overview',
  summary: 'overview',
  'key points': 'keyPoints',
  'key discussion points': 'keyPoints',
  decisions: 'decisions',
  'decisions made': 'decisions',
  'action items': 'actionItems',
  'next steps': 'actionItems',
  'open questions': 'openQuestions',
  'unanswered questions': 'openQuestions'
}

const EMPTY = /^(none( yet)?|n\/a|nothing( yet)?|-)\.?$/i

/** Parse the sectioned Markdown produced by the "summarize" action into structured fields. */
export function parseSummary(markdown: string, now = Date.now()): MeetingSummary {
  const summary: MeetingSummary = {
    overview: '',
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    updatedAt: now,
    markdown: markdown.trim()
  }
  let current: string | null = null
  const overview: string[] = []
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const heading = /^#{1,6}\s*(.+?)\s*:?\s*$/.exec(line) ?? /^\*\*(.+?)\*\*:?\s*$/.exec(line)
    if (heading) {
      const name = heading[1].replace(/\(.*?\)/g, '').replace(/[*_:]/g, '').trim().toLowerCase()
      current = SECTION_KEYS[name] ?? null
      continue
    }
    if (!line || !current) continue
    const item = line.replace(/^([-*•]|\d+[.)])\s+/, '').trim()
    if (!item || EMPTY.test(item)) continue
    if (current === 'overview') overview.push(item)
    else (summary[current as 'keyPoints'] as string[]).push(item)
  }
  summary.overview = overview.join(' ')
  if (!summary.overview && !summary.keyPoints.length && markdown.trim()) {
    // Unstructured answer: keep it as the overview so nothing is lost.
    summary.overview = markdown.trim()
  }
  return summary
}
