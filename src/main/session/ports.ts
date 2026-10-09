import type {
  AudioCaptureConfig,
  CaptureCommand,
  EventChannel,
  EventMap,
  GrabRequest,
  GrabResult,
  LocalSttRequest
} from '@shared/ipc'
import type { CaptureSource, Rect } from '@shared/types'

/** Pushes events to every UI window. */
export interface Broadcaster {
  send<K extends EventChannel>(channel: K, payload: EventMap[K]): void
}

/** The hidden capture renderer that owns microphone/system-audio/screen streams. */
export interface CaptureDriver {
  command(cmd: CaptureCommand): void
  grab(req: Omit<GrabRequest, 'requestId'>, timeoutMs?: number): Promise<GrabResult>
  localTranscribe(req: Omit<LocalSttRequest, 'requestId'>, signal: AbortSignal): Promise<string>
}

/** OS-specific screen source discovery and window geometry (Electron in production). */
export interface ScreenSourceProvider {
  list(): Promise<CaptureSource[]>
  /** Bounds of the display behind a screen source, in DIP. */
  displayBounds(source: CaptureSource): Rect | undefined
  /** Rectangles of our own visible windows (DIP) to mask out of screen captures. */
  ownWindowRects(): Rect[]
  /** Let the user drag a region on the given display; resolves to DIP rect or null. */
  pickRegion(displayId: string | undefined): Promise<Rect | null>
}

export type { AudioCaptureConfig }
