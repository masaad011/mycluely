import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  assessScreenQuality,
  cleanOcrWords,
  isScreenChanged,
  prepareOcrPixels,
  screenChangeRatio
} from '@shared/screen'

/** A 160x90 grayscale "page": white background with rows of glyph-like dark pixels. */
function page(seed: number, shiftRows = 0): Uint8Array {
  const out = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT).fill(250)
  let s = seed
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let row = 15; row < 85; row += 9) {
    for (let x = 10; x < 150; x++) {
      for (let dy = 0; dy < 2; dy++) {
        const y = row + dy + shiftRows
        if (y < SIGNATURE_HEIGHT && rand() < 0.45) out[y * SIGNATURE_WIDTH + x] = 40 + Math.floor(rand() * 60)
      }
    }
  }
  return out
}

describe('screen change detection', () => {
  it('treats identical frames and a moving cursor as unchanged', () => {
    const a = page(1)
    expect(screenChangeRatio(a, page(1))).toBe(0)
    const cursor = page(1)
    cursor[40 * SIGNATURE_WIDTH + 80] = 0
    cursor[41 * SIGNATURE_WIDTH + 80] = 0
    expect(isScreenChanged(a, cursor)).toBe(false)
  })

  it('detects new text with the same layout (e.g. next slide) and scrolling', () => {
    // The old 9x8 dHash saw two different slides as identical (1 bit apart).
    expect(isScreenChanged(page(1), page(2))).toBe(true)
    expect(isScreenChanged(page(1), page(1, 3))).toBe(true)
  })

  it('always reports a change when there is no previous frame', () => {
    expect(isScreenChanged(undefined, page(1))).toBe(true)
    expect(isScreenChanged(page(1), undefined)).toBe(true)
  })
})

describe('OCR post-processing', () => {
  const lines = [
    // A solid UI bar read as junk.
    { words: [{ text: 'RRR', confidence: 72 }, { text: 'RR', confidence: 64 }, { text: 'EERE,', confidence: 55 }] },
    { words: [{ text: 'Quarterly', confidence: 95 }, { text: 'Revenue', confidence: 93 }, { text: 'Review', confidence: 96 }] },
    { words: [{ text: '«', confidence: 31 }, { text: 'Customer', confidence: 91 }, { text: 'churn', confidence: 88 }, { text: 'xq#z', confidence: 12 }] },
    { words: [{ text: 'if', confidence: 90 }, { text: '(x)', confidence: 84 }, { text: '{', confidence: 86 }] }
  ]

  it('drops junk tokens but keeps confident code punctuation', () => {
    const r = cleanOcrWords(lines)
    expect(r.text).toBe('Quarterly Revenue Review\nCustomer churn\nif (x) {')
  })

  it('scores readability by the share of text in confidently read words', () => {
    const r = cleanOcrWords(lines)
    expect(r.confidentShare).toBeGreaterThan(0.95)
    expect(r.wordCount).toBe(8)
    const q = assessScreenQuality({ text: r.text, confidence: 69, confidentShare: r.confidentShare })
    expect(q.quality).toBe('clear')
  })

  it('still flags genuinely poor recognition', () => {
    const blurry = [
      { words: [{ text: 'Qvarterlv', confidence: 48 }, { text: 'Revenve', confidence: 52 }, { text: 'Rcview', confidence: 45 }] },
      { words: [{ text: 'Customer', confidence: 74 }, { text: 'chum', confidence: 50 }, { text: 'decreased', confidence: 58 }] }
    ]
    const r = cleanOcrWords(blurry)
    expect(assessScreenQuality({ text: r.text, confidence: 55, confidentShare: r.confidentShare }).quality).toBe('unreadable')
    const mixed = [...blurry, { words: [{ text: 'Next', confidence: 92 }, { text: 'step:', confidence: 90 }, { text: 'migrate', confidence: 91 }, { text: 'billing', confidence: 93 }] }]
    const m = cleanOcrWords(mixed)
    expect(assessScreenQuality({ text: m.text, confidence: 66, confidentShare: m.confidentShare }).quality).toBe('partial')
  })
})

describe('OCR image preparation', () => {
  /** 128x64 RGBA image: left half dark theme with light text, right half light page with dark text. */
  function mixed(): Uint8ClampedArray {
    const w = 128
    const h = 64
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isText = y % 8 === 3 && x % 3 !== 0
        const dark = x < 64
        const v = dark ? (isText ? 220 : 30) : isText ? 20 : 245
        const i = (y * w + x) * 4
        d[i] = d[i + 1] = d[i + 2] = v
        d[i + 3] = 255
      }
    }
    return d
  }

  it('turns both dark and light regions into dark text on a light background', () => {
    const d = mixed()
    prepareOcrPixels(d, 128, 64, 64)
    const px = (x: number, y: number): number => d[(y * 128 + x) * 4]
    // Dark-theme half: background became light, text became dark.
    expect(px(10, 0)).toBeGreaterThan(200)
    expect(px(10, 3)).toBeLessThan(60)
    // Light half untouched apart from grayscale.
    expect(px(100, 0)).toBeGreaterThan(200)
    expect(px(100, 3)).toBeLessThan(60)
  })
})
