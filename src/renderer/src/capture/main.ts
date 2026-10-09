import type { CaptureCommand, GrabRequest, LocalSttRequest } from '@shared/ipc'
import { AudioEngine } from './audio-engine'
import { LocalStt } from './local-stt'
import { ScreenGrabber } from './screen-grabber'

// Headless capture engine: runs in a hidden window so the UI windows can be closed or reloaded
// without interrupting audio capture, and so heavy media work never touches the UI thread.
const bridge = window.mycluely.capture

const log = (level: 'info' | 'warn' | 'error', message: string): void => bridge.send('capture:log', { level, message })

const audio = new AudioEngine({
  segment: (m) => bridge.send('capture:segment', m),
  levels: (l) => bridge.send('capture:levels', l),
  channel: (m) => bridge.send('capture:channel', m),
  devices: (d) => bridge.send('capture:devices', d),
  log
})
const grabber = new ScreenGrabber()
const stt = new LocalStt((p) => bridge.send('local-stt:progress', p))

bridge.on('capture:command', (cmd: CaptureCommand) => void audio.handle(cmd))

bridge.on('capture:grab', async (req: GrabRequest) => {
  bridge.send('capture:grab-result', await grabber.grab(req))
})

bridge.on('local-stt:transcribe', async (req: LocalSttRequest) => {
  try {
    const text = await stt.transcribe(req)
    bridge.send('local-stt:result', { requestId: req.requestId, ok: true, text })
  } catch (err) {
    bridge.send('local-stt:result', { requestId: req.requestId, ok: false, error: String((err as Error)?.message ?? err) })
  }
})

window.addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${String(e.reason)}`))

bridge.send('capture:ready', null)
void audio.refreshDevices()
