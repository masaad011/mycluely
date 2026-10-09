/**
 * Text heuristics for answering what is on screen (Auto answer mode). They decide whether a
 * capture is worth sending to the model and whether it is new; the model makes the final call
 * (it can reply that nothing needs an answer).
 */

/** Distinct words of screen text (lower case, 2+ letters/digits), for comparing captures. */
export function screenWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
}

/**
 * Whether two captures show essentially the same text. OCR of an unchanged screen varies a little
 * (a clock, a cursor, a misread character), so this compares word sets rather than exact text.
 */
export function sameScreenText(a: Set<string>, b: Set<string>, threshold = 0.9): boolean {
  if (!a.size && !b.size) return true
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared) >= threshold
}

/**
 * Whether `current` shows something not already seen: at least `minNew` words that appear in none
 * of the `seen` captures. Measuring only added words means scrolling back, a ticking clock or a
 * re-read of the same screen is not "new", while a new message in a long chat still is.
 */
export function hasNewContent(current: Set<string>, seen: Iterable<Set<string>>, minNew = 4): boolean {
  const all = [...seen]
  if (!all.length) return true
  let added = 0
  for (const w of current) {
    if (!all.some((s) => s.has(w)) && ++added >= Math.min(minNew, current.size)) return true
  }
  return false
}

const ASK =/^(what|why|how|which|who|whom|whose|when|where|can|could|would|should|will|is|are|was|were|do|does|did|has|have|explain|describe|write|implement|solve|calculate|compute|find|determine|choose|select|pick|identify|fix|debug|prove|compare|contrast|list|define|translate|summari[sz]e|give|name|design|build|create|refactor|optimi[sz]e|analy[sz]e|evaluate|discuss|outline|draft|reply|respond|estimate|predict|convert|complete|fill in|tell me|walk me)\b/i
const MARKERS =
  /\b(?:question|problem|exercise|task|assignment|prompt|quiz|challenge|interview|traceback|exception|error|failed|todo)\b|\bq\d+[.:)]|\bexample \d+\b|\b(?:input|output|constraints?|expected):/i
const OPTIONS = /(^|\s)[A-Da-d][).]\s+\S/

/**
 * Cheap local check that screen text contains something that may need an answer: a question, a
 * task or instruction, a problem statement, multiple-choice options or an error. Avoids a model
 * request for screens that are plainly just content.
 */
export function looksAnswerable(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[\s•·*\-–—>\d.)]+/, '').trim()).filter((l) => l.length > 2)
  for (const l of lines) {
    const words = l.split(/\s+/).length
    if (/[?？]\s*["”')\]]?\s*$/.test(l) && words >= 3) return true
    if (ASK.test(l) && words >= 4) return true
    if (MARKERS.test(l)) return true
    if (OPTIONS.test(l) && words >= 2) return true
  }
  return false
}
