import { ipcMain, type IpcMainEvent } from 'electron'
import type {
  AudioSegmentMessage,
  CaptureCommand,
  ChannelStatusMessage,
  GrabRequest,
  GrabResult,
  LocalSttProgress,
  LocalSttRequest,
  LocalSttResult
} from '@shared/ipc'
import type { AudioDevice, AudioLevels } from '@shared/types'
import { newId } from '@shared/util'
import type { CaptureDriver } from './session/ports'
import type { WindowManager } from './windows'

const LOCAL_STT_STALL_MS = 90_000

export interface CaptureHandlers {
  segment(msg: AudioSegmentMessage): void
  levels(levels: AudioLevels): void
  channel(msg: ChannelStatusMessage): void
  devices(devices: AudioDevice[]): void
  sttProgress(p: LocalSttProgress): void
  log(level: string, message: string): void
}

/**
 * Bridges the main process to the hidden capture renderer. Commands issued before the renderer
 * is ready are queued; if the renderer crashes it is recreated and an active capture resumes.
 */
export class ElectronCaptureDriver implements CaptureDriver {
  private ready = false
  private queue: CaptureCommand[] = []
  /** The capture state the renderer should be in (replayed after a crash). */
  private desired: { start?: CaptureCommand; paused: boolean } = { paused: false }
  private grabs = new Map<string, { resolve: (r: GrabResult) => void; timer: NodeJS.Timeout }>()
  private stt = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>()
  private lastSttActivity = 0

  constructor(
    private readonly windows: WindowManager,
    private readonly handlers: CaptureHandlers
  ) {}

  attach(): void {
    const on = <T>(channel: string, fn: (payload: T) => void): void => {
      ipcMain.on(channel, (e: IpcMainEvent, payload: T) => {
        if (!this.windows.isCaptureSender(e.sender)) return
        fn(payload)
      })
    }
    on('capture:ready', () => this.onReady())
    on<AudioSegmentMessage>('capture:segment', (m) => {
      if (m && (m.source === 'mic' || m.source === 'system') && m.wav instanceof Uint8Array) this.handlers.segment(m)
    })
    on<AudioLevels>('capture:levels', (l) => this.handlers.levels(l))
    on<ChannelStatusMessage>('capture:channel', (m) => this.handlers.channel(m))
    on<AudioDevice[]>('capture:devices', (d) => this.handlers.devices(Array.isArray(d) ? d : []))
    on<GrabResult>('capture:grab-result', (r) => {
      const p = this.grabs.get(r?.requestId)
      if (!p) return
      clearTimeout(p.timer)
      this.grabs.delete(r.requestId)
      p.resolve(r)
    })
    on<LocalSttResult>('local-stt:result', (r) => {
      const p = this.stt.get(r?.requestId)
      if (!p) return
      this.stt.delete(r.requestId)
      if (r.ok) p.resolve(r.text ?? '')
      else p.reject(new Error(r.error ?? 'Local transcription failed'))
    })
    on<LocalSttProgress>('local-stt:progress', (p) => {
      this.lastSttActivity = Date.now()
      this.handlers.sttProgress(p)
    })
    on<{ level: string; message: string }>('capture:log', (m) => this.handlers.log(m.level, m.message))
  }

  private onReady(): void {
    this.ready = true
    // Replay desired state after a renderer restart, then anything queued.
    const replay: CaptureCommand[] = []
    if (this.desired.start) {
      replay.push(this.desired.start)
      if (this.desired.paused) replay.push({ type: 'pause' })
    }
    const queued = this.queue.filter((c) => c.type !== 'start' && c.type !== 'pause' && c.type !== 'resume' && c.type !== 'stop')
    this.queue = []
    for (const c of [...replay, ...queued, { type: 'refresh-devices' } as CaptureCommand]) this.post(c)
  }

  /** The renderer died: fail pending work; it is re-created by the window manager. */
  onCrashed(): void {
    this.ready = false
    for (const [id, p] of this.grabs) {
      clearTimeout(p.timer)
      p.resolve({ requestId: id, ok: false, error: 'Capture engine restarted — try again.' })
    }
    this.grabs.clear()
    for (const p of this.stt.values()) p.reject(new Error('Capture engine restarted'))
    this.stt.clear()
  }

  private post(cmd: CaptureCommand): void {
    this.windows.capture?.webContents.send('capture:command', cmd)
  }

  command(cmd: CaptureCommand): void {
    if (cmd.type === 'start') this.desired = { start: cmd, paused: false }
    else if (cmd.type === 'configure' && this.desired.start) this.desired.start = { type: 'start', audio: cmd.audio }
    else if (cmd.type === 'pause') this.desired.paused = true
    else if (cmd.type === 'resume') this.desired.paused = false
    else if (cmd.type === 'stop') this.desired = { paused: false }
    if (!this.ready || !this.windows.capture) {
      this.queue.push(cmd)
      return
    }
    this.post(cmd)
  }

  grab(req: Omit<GrabRequest, 'requestId'>, timeoutMs = 15_000): Promise<GrabResult> {
    const requestId = newId('g')
    return new Promise((resolve) => {
      if (!this.ready || !this.windows.capture) {
        resolve({ requestId, ok: false, error: 'Capture engine is not ready yet — try again in a moment.' })
        return
      }
      const timer = setTimeout(() => {
        this.grabs.delete(requestId)
        resolve({ requestId, ok: false, error: 'Screen capture timed out.' })
      }, timeoutMs)
      this.grabs.set(requestId, { resolve, timer })
      this.windows.capture.webContents.send('capture:grab', { ...req, requestId } satisfies GrabRequest)
    })
  }

  localTranscribe(req: Omit<LocalSttRequest, 'requestId'>, signal: AbortSignal): Promise<string> {
    const requestId = newId('stt')
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.windows.capture) return reject(new Error('Capture engine is not ready'))
      const startedAt = Date.now()
      // Watchdog: a stalled model download or hung inference must not block the queue forever.
      // Download progress counts as activity, so a slow first download is not cut off.
      const watchdog = setInterval(() => {
        if (Date.now() - Math.max(startedAt, this.lastSttActivity) > LOCAL_STT_STALL_MS) {
          this.stt.get(requestId)?.reject(new Error(`timed out (no progress for ${LOCAL_STT_STALL_MS / 1000} s)`))
          this.stt.delete(requestId)
        }
      }, 5000)
      const cleanup = (): void => {
        clearInterval(watchdog)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        this.stt.delete(requestId)
        reject(new Error('aborted'))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      this.stt.set(requestId, {
        resolve: (t) => {
          cleanup()
          this.lastSttActivity = Date.now()
          resolve(t)
        },
        reject: (e) => {
          cleanup()
          reject(e)
        }
      })
      this.windows.capture.webContents.send('local-stt:transcribe', { ...req, requestId } satisfies LocalSttRequest)
    })
  }
}
