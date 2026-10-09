import type { Rect, ScreenQuality } from './types'

export interface QualityInput {
  text: string
  /** Mean OCR confidence 0..100 (fallback when no word-level data is available). */
  confidence: number
  /** Share (0..1) of recognised characters in words read with confidence ≥ 70. */
  confidentShare?: number
  /** Fraction of near-uniform pixels (0..1); ~1 = blank frame. */
  blankness?: number
}

export interface QualityResult {
  quality: Exclude<ScreenQuality, 'pending'>
  note?: string
}

/** Judge how trustworthy the OCR text of a capture is, with a human-readable note. */
export function assessScreenQuality(input: QualityInput): QualityResult {
  if ((input.blankness ?? 0) > 0.985) {
    return {
      quality: 'unreadable',
      note: 'The capture is blank — the window may be minimised, covered, or showing protected content.'
    }
  }
  const words = input.text.split(/\s+/).filter((t) => /[\p{L}\p{N}]{2,}/u.test(t))
  if (words.length < 3) {
    return {
      quality: 'unreadable',
      note: words.length === 0
        ? 'No readable text found — the screen may show an image, chart or video.'
        : 'Almost no readable text found.'
    }
  }
  // Word-level share is robust to UI chrome and icons, which drag a plain mean down.
  const share = input.confidentShare ?? input.confidence / 100
  if (share >= 0.75) return { quality: 'clear' }
  if (share >= 0.45) {
    return { quality: 'partial', note: 'Some text is small, stylised or low-contrast and may be misread.' }
  }
  return { quality: 'unreadable', note: 'Text recognition confidence is low; most text could not be read reliably.' }
}

export interface OcrWord {
  text: string
  confidence: number
}

export interface CleanOcr {
  text: string
  /** Mean confidence of the kept words, weighted by length (0..100). */
  confidence: number
  /** Share (0..1) of kept characters in words read with confidence ≥ 70. */
  confidentShare: number
  wordCount: number
}

function isJunkWord(w: OcrWord): boolean {
  const t = w.text.trim()
  if (!t) return true
  if (w.confidence < 30) return true
  const alnum = (t.match(/[\p{L}\p{N}]/gu) ?? []).length
  // Lone symbols misread from bullets/icons; confident ones (code punctuation) are kept.
  if (alnum === 0 && w.confidence < 60) return true
  // "RR", "IIII", "EERE": solid bars, borders and icons read as repeated letters.
  const letters = t.replace(/[^\p{L}]/gu, '')
  if (w.confidence < 90 && letters.length >= 2) {
    const distinct = new Set(letters.toUpperCase()).size
    if (distinct === 1) return true
    if (distinct === 2 && letters.length >= 4 && letters === letters.toUpperCase()) return true
  }
  return false
}

/**
 * Turn Tesseract's word-level output into clean text and an honest readability score: junk from
 * icons, borders and toolbars is dropped (whole lines when they are mostly junk), and confidence
 * is measured on what remains.
 */
export function cleanOcrWords(lines: { words: OcrWord[] }[]): CleanOcr {
  const outLines: string[] = []
  let chars = 0
  let confidentChars = 0
  let weighted = 0
  let wordCount = 0
  for (const line of lines) {
    const words = line.words.filter((w) => w.text.trim())
    if (!words.length) continue
    const kept = words.filter((w) => !isJunkWord(w))
    if (kept.length === 0 || kept.length < words.length / 2) continue
    outLines.push(kept.map((w) => w.text.trim()).join(' '))
    for (const w of kept) {
      const n = w.text.trim().length
      chars += n
      weighted += w.confidence * n
      if (w.confidence >= 70) confidentChars += n
      wordCount++
    }
  }
  return {
    text: outLines.join('\n'),
    confidence: chars ? weighted / chars : 0,
    confidentShare: chars ? confidentChars / chars : 0,
    wordCount
  }
}

/** Size of the grayscale thumbnail used to detect screen changes. */
export const SIGNATURE_WIDTH = 160
export const SIGNATURE_HEIGHT = 90

/** Fraction of signature pixels whose brightness changed noticeably. */
export function screenChangeRatio(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 1
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) changed++
  return changed / a.length
}

/**
 * True when the screen content changed enough to be worth reading again. A 160x90 thumbnail is
 * fine enough to see a changed line of text (new slide, scrolling, edited code) while ignoring a
 * moving cursor or blinking caret.
 */
export function isScreenChanged(prev: ArrayLike<number> | undefined, next: ArrayLike<number> | undefined): boolean {
  if (!prev || !next) return true
  return screenChangeRatio(prev, next) > 0.0015
}

/** Convert a rectangle in display coordinates into fractions of the display. */
export function toFractions(rect: Rect, bounds: Rect): Rect {
  return {
    x: clamp01((rect.x - bounds.x) / bounds.width),
    y: clamp01((rect.y - bounds.y) / bounds.height),
    width: clamp01(rect.width / bounds.width),
    height: clamp01(rect.height / bounds.height)
  }
}

/** Intersection of two rectangles, or null. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const bt = Math.min(a.y + a.height, b.y + b.height)
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * Prepare RGBA pixels for OCR in place: convert to grayscale and invert dark regions (dark
 * themes, dark slides, terminals) so text is always dark-on-light, which Tesseract reads best.
 * Works per tile so a screen with a dark sidebar and a light document gets both right.
 */
export function prepareOcrPixels(data: Uint8ClampedArray, width: number, height: number, tile = 64): void {
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
  }
  const hist = new Uint32Array(256)
  for (let ty = 0; ty < height; ty += tile) {
    for (let tx = 0; tx < width; tx += tile) {
      const x1 = Math.min(width, tx + tile)
      const y1 = Math.min(height, ty + tile)
      hist.fill(0)
      for (let y = ty; y < y1; y++) for (let x = tx; x < x1; x++) hist[gray[y * width + x]]++
      // The median is the background brightness (text covers well under half of a tile).
      const half = ((x1 - tx) * (y1 - ty)) / 2
      let acc = 0
      let median = 0
      for (; median < 256; median++) {
        acc += hist[median]
        if (acc >= half) break
      }
      const invert = median < 110
      for (let y = ty; y < y1; y++) {
        for (let x = tx; x < x1; x++) {
          const p = y * width + x
          const v = invert ? 255 - gray[p] : gray[p]
          const i = p * 4
          data[i] = data[i + 1] = data[i + 2] = v
          data[i + 3] = 255
        }
      }
    }
  }
}
