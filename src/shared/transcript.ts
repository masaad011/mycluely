import type { TranscriptSegment } from './types'
import { normalizeWords, wordSimilarity } from './util'

/**
 * Phrases speech-to-text models commonly invent for silence, music or noise. A segment that
 * consists only of one of these (and is short) is dropped.
 */
const HALLUCINATIONS = [
  'thank you',
  'thanks',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching and see you next time',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'bye',
  'bye bye',
  'you',
  'so',
  'okay',
  'oh',
  'um',
  'uh',
  'hmm',
  'music',
  'applause',
  'silence',
  'blank audio',
  'inaudible',
  'subtitles by the amara org community',
  'transcribed by',
  'the end'
]

const HALLUCINATION_SET = new Set(HALLUCINATIONS)

export function cleanTranscriptText(text: string): string {
  return text
    .replace(/\[(?:BLANK_AUDIO|MUSIC|Music|NOISE|noise|silence|Silence|inaudible)\]/g, '')
    .replace(/\((?:music|applause|silence|inaudible|background noise)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True if the text is empty or a known filler/hallucination for a short segment. */
export function isLikelyHallucination(text: string, durationMs: number): boolean {
  const cleaned = cleanTranscriptText(text)
  if (!cleaned) return true
  const norm = normalizeWords(cleaned).join(' ')
  if (!norm) return true
  if (HALLUCINATION_SET.has(norm) && durationMs < 4000) return true
  // Repeated single token ("you you you you") is a classic Whisper loop on noise.
  const words = norm.split(' ')
  if (words.length >= 4 && new Set(words).size === 1) return true
  return false
}

/**
 * When the user listens on speakers, the microphone also hears the remote participants. Drop a
 * microphone segment if a system-audio segment overlapping in time says (nearly) the same thing.
 */
export function isEchoOfRemote(
  mic: Pick<TranscriptSegment, 'text' | 'startMs' | 'endMs'>,
  recent: Pick<TranscriptSegment, 'text' | 'startMs' | 'endMs' | 'source'>[],
  toleranceMs = 3000,
  threshold = 0.55
): boolean {
  for (const seg of recent) {
    if (seg.source !== 'system') continue
    const overlaps = mic.startMs <= seg.endMs + toleranceMs && mic.endMs >= seg.startMs - toleranceMs
    if (!overlaps) continue
    if (wordSimilarity(mic.text, seg.text) >= threshold) return true
    // Short mic fragment fully contained in a longer remote sentence.
    const micWords = normalizeWords(mic.text)
    if (micWords.length >= 3) {
      const remote = ' ' + normalizeWords(seg.text).join(' ') + ' '
      if (remote.includes(' ' + micWords.join(' ') + ' ')) return true
    }
  }
  return false
}

/** Render transcript lines as "[mm:ss] Speaker: text". */
export function formatTranscriptLines(
  segments: Pick<TranscriptSegment, 'speaker' | 'text' | 'startMs' | 'status'>[],
  clock: (ms: number) => string
): string[] {
  return segments
    .filter((s) => s.status === 'ok' && s.text)
    .map((s) => `[${clock(s.startMs)}] ${s.speaker}: ${s.text}`)
}
