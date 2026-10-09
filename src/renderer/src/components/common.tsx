import { useEffect, useRef, useState, type ReactNode } from 'react'
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

/**
 * Drag handle between two panels. `value` is the size of the panel before the handle as a fraction
 * of the parent (or pixels with `unit="px"`). Drag with the mouse, use the arrow keys when focused,
 * or double-click to reset. `onChange` fires while dragging; `onCommit` once at the end.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  unit = 'fraction',
  label,
  onChange,
  onCommit,
  onReset
}: {
  /** `vertical`: a vertical bar between columns (drag left/right). `horizontal`: between rows. */
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  unit?: 'fraction' | 'px'
  label: string
  onChange: (v: number) => void
  onCommit: (v: number) => void
  onReset?: () => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    const rect = parent.getBoundingClientRect()
    const at = (ev: PointerEvent): number => {
      const pos = orientation === 'vertical' ? ev.clientX - rect.left : ev.clientY - rect.top
      return clamp(unit === 'px' ? pos : pos / (orientation === 'vertical' ? rect.width : rect.height))
    }
    let last = value
    const move = (ev: PointerEvent): void => {
      last = at(ev)
      onChange(last)
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing', `resizing-${orientation}`)
      setDragging(false)
      onCommit(last)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    document.body.classList.add('resizing', `resizing-${orientation}`)
    setDragging(true)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = (unit === 'px' ? 16 : 0.02) * (e.shiftKey ? 3 : 1)
    const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const next = clamp(value + (e.key === keys[0] ? -step : step))
    onChange(next)
    onCommit(next)
  }
  const pct = (v: number): number => Math.round(((v - min) / (max - min)) * 100)
  return (
    <div
      ref={ref}
      className={`splitter ${orientation}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct(value)}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
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
