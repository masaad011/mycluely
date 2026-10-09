export interface SuggestedQuestion {
  question: string
  /** Why it is worth asking (the model's short parenthetical), if given. */
  reason?: string
}

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/
const TRAILING_REASON = /^(.*?)\s*\(([^()]{2,160})\)\s*\.?$/

function clean(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/^[“"']+|[”"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function split(line: string): SuggestedQuestion {
  const m = TRAILING_REASON.exec(line)
  // "(…)" right after the question mark is the reason; anything else is part of the question.
  if (m && /[?？]\W*$/.test(m[1])) {
    return { question: clean(m[1]), reason: clean(m[2]) }
  }
  return { question: clean(line) }
}

/**
 * Turn a "Questions to ask" response into individual questions. The prompt asks for one bullet
 * per question with a short reason in parentheses; this also copes with numbered lists, bold
 * markers, the reason on its own line, and plain lines ending in "?". Partial (still streaming)
 * text yields the questions seen so far.
 */
export function parseSuggestedQuestions(text: string): SuggestedQuestion[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out: SuggestedQuestion[] = []
  const bulleted = lines.some((l) => BULLET.test(l))
  for (const line of lines) {
    const bullet = BULLET.exec(line)
    const standaloneReason = /^\(([^()]+)\)\.?$/.exec(line)
    if (standaloneReason && out.length && !out[out.length - 1].reason) {
      out[out.length - 1].reason = clean(standaloneReason[1])
      continue
    }
    if (bullet) {
      const item = split(bullet[1])
      if (item.question) out.push(item)
    } else if (!bulleted && /[?？]\s*(\([^()]*\))?\s*$/.test(line)) {
      const item = split(line)
      if (item.question) out.push(item)
    }
  }
  return out
}
