import type { GrabRequest, GrabResult } from '@shared/ipc'
import type { Rect } from '@shared/types'
import { SIGNATURE_HEIGHT, SIGNATURE_WIDTH, prepareOcrPixels } from '@shared/screen'

const IDLE_RELEASE_MS = 45_000
const OCR_TARGET_WIDTH = 2400
const VISION_MAX_SIDE = 1600
const THUMB_WIDTH = 360

interface Held {
  sourceId: string
  stream: MediaStream
  video: HTMLVideoElement
  releaseTimer: number | null
}

/**
 * Grabs still frames from a screen or window. A low-frame-rate stream is kept open while frames
 * are being requested (fast repeated captures) and released after a period of inactivity.
 */
export class ScreenGrabber {
  private held: Held | null = null

  async grab(req: GrabRequest): Promise<GrabResult> {
    try {
      const video = await this.acquire(req.sourceId)
      await waitForFreshFrame(video, 300)
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) throw new Error('The capture source returned no image.')

      const crop = req.region ? fractionToPixels(req.region, vw, vh) : { x: 0, y: 0, width: vw, height: vh }
      const canvas = new OffscreenCanvas(crop.width, crop.height)
      const g = canvas.getContext('2d', { willReadFrequently: true })!
      g.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
      // Black out our own windows so the assistant never reads its own output.
      g.fillStyle = '#000'
      for (const m of req.masks) {
        const r = fractionToPixels(m, vw, vh)
        g.fillRect(r.x - crop.x, r.y - crop.y, r.width, r.height)
      }

      // Change check for screen watching: no image encoding, just the signature (a few ms).
      if (req.probe) {
        return { requestId: req.requestId, ok: true, width: crop.width, height: crop.height, signature: signatureOf(canvas), blankness: blanknessOf(canvas) }
      }

      const ocrScale = Math.min(2, Math.max(1, OCR_TARGET_WIDTH / crop.width))
      const ocrPng = await encodeForOcr(canvas, ocrScale)
      const visionScale = Math.min(1, VISION_MAX_SIDE / Math.max(crop.width, crop.height))
      const visionJpeg = await encode(canvas, visionScale, 'image/jpeg', 0.85)
      const thumbBlob = await toBlob(canvas, THUMB_WIDTH / crop.width, 'image/jpeg', 0.72)

      return {
        requestId: req.requestId,
        ok: true,
        width: crop.width,
        height: crop.height,
        ocrPng,
        visionJpeg,
        thumbnail: await blobToDataUrl(thumbBlob),
        signature: signatureOf(canvas),
        blankness: blanknessOf(canvas)
      }
    } catch (err) {
      this.release()
      return { requestId: req.requestId, ok: false, error: describe(err) }
    } finally {
      this.scheduleRelease()
    }
  }

  private async acquire(sourceId: string): Promise<HTMLVideoElement> {
    if (this.held?.sourceId === sourceId && this.held.stream.active) return this.held.video
    this.release()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 5
        }
      }
    } as unknown as MediaStreamConstraints)
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    try {
      await video.play()
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2 && video.videoWidth) return resolve()
        const t = setTimeout(() => reject(new Error('Timed out waiting for the first frame — is the window minimised?')), 6000)
        video.addEventListener(
          'loadeddata',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true }
        )
      })
    } catch (err) {
      // Not yet tracked in `held`, so release it here or it would keep capturing.
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
      throw err
    }
    this.held = { sourceId, stream, video, releaseTimer: null }
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.held?.stream === stream) this.release()
    })
    return video
  }

  private scheduleRelease(): void {
    if (!this.held) return
    if (this.held.releaseTimer !== null) clearTimeout(this.held.releaseTimer)
    this.held.releaseTimer = window.setTimeout(() => this.release(), IDLE_RELEASE_MS)
  }

  release(): void {
    if (!this.held) return
    if (this.held.releaseTimer !== null) clearTimeout(this.held.releaseTimer)
    for (const t of this.held.stream.getTracks()) t.stop()
    this.held.video.srcObject = null
    this.held = null
  }
}

function fractionToPixels(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.round(r.x * w))
  const y = Math.max(0, Math.round(r.y * h))
  return {
    x,
    y,
    width: Math.max(1, Math.min(w - x, Math.round(r.width * w))),
    height: Math.max(1, Math.min(h - y, Math.round(r.height * h)))
  }
}

function waitForFreshFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  // Windows Graphics Capture only delivers frames when content changes, so a static screen may
  // never produce a new frame; the current frame is then up to date anyway.
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(() => {
        clearTimeout(t)
        resolve()
      })
    }
  })
}

async function toBlob(src: OffscreenCanvas, scale: number, type: string, quality?: number): Promise<Blob> {
  if (scale === 1) return src.convertToBlob({ type, quality })
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, w, h)
  return c.convertToBlob({ type, quality })
}

async function encode(src: OffscreenCanvas, scale: number, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await toBlob(src, scale, type, quality)
  return new Uint8Array(await blob.arrayBuffer())
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function grayPixels(src: OffscreenCanvas, w: number, h: number): Float32Array {
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  return out
}

/** Grayscale thumbnail for change detection (fine enough to notice a changed line of text). */
function signatureOf(src: OffscreenCanvas): Uint8Array {
  const g = grayPixels(src, SIGNATURE_WIDTH, SIGNATURE_HEIGHT)
  const out = new Uint8Array(g.length)
  for (let i = 0; i < g.length; i++) out[i] = g[i]
  return out
}

/** Upscaled, grayscale, dark-regions-inverted PNG: what Tesseract reads most reliably. */
async function encodeForOcr(src: OffscreenCanvas, scale: number): Promise<Uint8Array> {
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, w, h)
  const img = g.getImageData(0, 0, w, h)
  prepareOcrPixels(img.data, w, h, Math.round(64 * scale))
  g.putImageData(img, 0, 0)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Fraction of pixels close to the dominant brightness (≈1 for blank/black frames). */
function blanknessOf(src: OffscreenCanvas): number {
  const px = grayPixels(src, 96, 54)
  const hist = new Array(52).fill(0)
  for (const v of px) hist[Math.min(51, Math.floor(v / 5))]++
  let peak = 0
  for (let i = 0; i < hist.length; i++) {
    const near = hist[i] + (hist[i - 1] ?? 0) + (hist[i + 1] ?? 0)
    if (near > peak) peak = near
  }
  return peak / px.length
}

function describe(err: unknown): string {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return 'Screen capture permission was denied.'
  if (e?.name === 'NotFoundError' || e?.name === 'NotReadableError' || /source/i.test(e?.message ?? '')) {
    return 'The selected screen or window is no longer available — pick another source.'
  }
  return e?.message || String(err)
}
