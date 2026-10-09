import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PanelId } from '@shared/settings'
import { DEFAULT_LAYOUT, expandPanel, toggleCollapsed, toggleMaximized } from '../lib/layout'
import { useStore } from '../lib/store'
import { IconChevronDown, IconChevronRight, IconChevronUp, IconExpand, IconShrink } from './icons'

const NAMES: Record<PanelId, string> = { transcript: 'Transcript', screen: 'Screen', assistant: 'Assistant' }

export function useLayout() {
  return useStore((s) => s.settings?.ui.layout) ?? DEFAULT_LAYOUT
}

/**
 * A saved size that follows drags and key presses at once: `preview` while moving, `commit` at the
 * end of a move (saves it). The local value is kept until the saved one catches up, so quick
 * repeated moves never jump back or lose a step.
 */
export function useLayoutValue(saved: number, save: (v: number) => void): [value: number, preview: (v: number) => void, commit: (v: number) => void] {
  const [draft, setDraft] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  useEffect(() => {
    // The save arrived, or the value changed elsewhere (another window, a reset): show it.
    if (pending.current === null || pending.current === saved) {
      pending.current = null
      setDraft(null)
    }
  }, [saved])
  const commit = (v: number): void => {
    if (v === saved) {
      pending.current = null
      setDraft(null)
      return
    }
    pending.current = v
    setDraft(v)
    save(v)
  }
  return [draft ?? saved, setDraft, commit]
}

/** Expand-to-fill and collapse buttons for a panel header. */
export function PaneControls({ id }: { id: PanelId }): ReactNode {
  const layout = useLayout()
  const maximized = layout.maximized === id
  const collapsed = layout.collapsed[id] && !maximized
  const name = NAMES[id]
  // The Assistant column collapses sideways into a rail; the others fold up to their header.
  const CollapseIcon = id === 'assistant' ? IconChevronRight : collapsed ? IconChevronDown : IconChevronUp
  return (
    <span className="pane-controls">
      {!collapsed && (
        <button
          className="btn ghost sm icon"
          onClick={() => toggleMaximized(id)}
          title={maximized ? `Restore the layout (Esc)` : `Expand ${name} to fill the view`}
          aria-label={maximized ? `Restore layout` : `Expand ${name}`}
          data-testid={`expand-${id}`}
        >
          {maximized ? <IconShrink /> : <IconExpand />}
        </button>
      )}
      {!maximized && (
        <button
          className="btn ghost sm icon"
          onClick={() => toggleCollapsed(id)}
          title={collapsed ? `Show ${name}` : `Collapse ${name}`}
          aria-label={collapsed ? `Show ${name}` : `Collapse ${name}`}
          aria-expanded={!collapsed}
          data-testid={`collapse-${id}`}
        >
          <CollapseIcon />
        </button>
      )}
    </span>
  )
}

/** A collapsed column: one vertical button per hidden panel. */
export function Rail({ side, panels }: { side: 'left' | 'right'; panels: { id: PanelId; icon: ReactNode }[] }): ReactNode {
  return (
    <div className={`rail rail-${side}`} role="toolbar" aria-orientation="vertical" aria-label="Collapsed panels">
      {panels.map((p) => (
        <button key={p.id} className="rail-btn" onClick={() => expandPanel(p.id)} title={`Show ${NAMES[p.id]}`} data-testid={`rail-${p.id}`}>
          {p.icon}
          <span className="rail-label">{NAMES[p.id]}</span>
        </button>
      ))}
    </div>
  )
}
