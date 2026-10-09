import { useEffect, useState, type ReactNode } from 'react'
import { dismissToast, useStore } from '../lib/store'
import { IconX } from './icons'

export function Meter({ level, speaking, active }: { level: number; speaking?: boolean; active: boolean }): ReactNode {
  const bars = 5
  const lit = active ? Math.round(Math.min(1, level * 1.15) * bars) : 0
  return (
    <span className={`meter${speaking ? ' speaking' : ''}`} aria-label={`level ${Math.round(level * 100)}%`}>
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  )
}

export function Toasts(): ReactNode {
  const toasts = useStore((s) => s.toasts) ?? []
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <div className="grow">
            <div>{t.message}</div>
            {t.detail && <div className="detail">{t.detail}</div>}
          </div>
          <button className="btn ghost sm icon" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <IconX />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3 className="grow">{title}</h3>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  title
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
  title?: string
}): ReactNode {
  return (
    <div className="segmented" role="radiogroup" aria-label={title}>
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? 'active' : ''} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Live mm:ss clock since `startedAt` (frozen when not running). */
export function useElapsed(startedAt: number | undefined, running: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return startedAt ? Math.max(0, now - startedAt) : 0
}

/** Human label for an Electron accelerator ("CommandOrControl+Shift+A" → "Ctrl+Shift+A"). */
export function accelLabel(accel: string | undefined, platform: string | undefined): string {
  if (!accel) return ''
  const mac = platform === 'darwin'
  return accel
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .replace(/Return/g, 'Enter')
}
