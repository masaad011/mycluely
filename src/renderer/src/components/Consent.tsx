import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Modal } from './common'

let resolver: ((ok: boolean) => void) | null = null
let setOpenGlobal: ((open: boolean) => void) | null = null

/** Ask the user to confirm participants are aware of transcription. Resolves true to proceed. */
export function confirmConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setOpenGlobal) return resolve(true)
    resolver = resolve
    setOpenGlobal(true)
  })
}

export function ConsentHost(): ReactNode {
  const [open, setOpen] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)
  setOpenGlobal = setOpen
  if (!open) return null
  const finish = (ok: boolean): void => {
    setOpen(false)
    if (ok && dontAsk) void api.invoke('settings:update', { privacy: { consentReminder: false } })
    resolver?.(ok)
    resolver = null
  }
  return (
    <Modal
      title="Before you start"
      onClose={() => finish(false)}
      footer={
        <>
          <label className="row small grow">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Don't remind me again
          </label>
          <button className="btn" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => finish(true)} data-testid="consent-start">
            Start listening
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        MyCluely will transcribe your microphone and the meeting audio playing on this PC, and can read your screen when you ask it to.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        Make sure meeting participants know the conversation is being transcribed, as required by law and by your organisation's policies.
        Transcripts are sent only to the AI providers you configured.
      </p>
    </Modal>
  )
}
