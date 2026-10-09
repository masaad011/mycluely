import { useSyncExternalStore } from 'react'
import type { AppSnapshot } from '@shared/ipc'
import type {
  AssistantResponse,
  AudioLevels,
  ScreenSnapshot,
  Toast,
  TranscriptSegment
} from '@shared/types'
import { api } from './api'
import { applyAppearance, applyTheme } from './theme'

export interface UiState extends AppSnapshot {
  loaded: boolean
  levels: AudioLevels
  toasts: Toast[]
}

type Listener = () => void

let state: UiState | null = null
const listeners = new Set<Listener>()

function set(patch: Partial<UiState>): void {
  if (!state) return
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function upsert<T extends { id: string }>(list: T[], item: T, sortKey?: (x: T) => number): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) {
    const next = list.slice()
    next[i] = item
    return next
  }
  const next = [...list, item]
  if (sortKey) {
    // Most inserts are appends; only sort when out of order.
    const n = next.length
    if (n > 1 && sortKey(next[n - 2]) > sortKey(next[n - 1])) next.sort((a, b) => sortKey(a) - sortKey(b))
  }
  return next
}

/** Same limits as the main process: 300 captures, preview images only for the latest 20. */
function capSnapshots(list: ScreenSnapshot[]): ScreenSnapshot[] {
  const capped = list.length > 300 ? list.slice(-300) : list
  const cut = capped.length - 20
  if (cut <= 0 || !capped[cut - 1]?.thumbnail) return capped
  return capped.map((x, i) => (i < cut && x.thumbnail ? { ...x, thumbnail: undefined } : x))
}

const pendingDeltas = new Map<string, string>()

function applyDeltas(): void {
  if (!state || !pendingDeltas.size) return
  const responses = state.responses.map((r) => {
    const d = pendingDeltas.get(r.id)
    return d ? { ...r, text: r.text + d } : r
  })
  pendingDeltas.clear()
  set({ responses })
}

let started = false

/** Load the live snapshot and subscribe to every main-process event. */
export async function initStore(): Promise<void> {
  if (started) return
  started = true
  const snap = await api.invoke('app:snapshot')
  applyTheme(snap.theme)
  applyAppearance(snap.settings.ui)
  state = {
    ...snap,
    loaded: true,
    levels: { mic: 0, system: 0, micSpeaking: false, systemSpeaking: false },
    toasts: []
  }
  for (const l of listeners) l()

  api.on('status', (status) => set({ status }))
  api.on('segment', (seg: TranscriptSegment) =>
    set({
      segments:
        seg.status === 'removed'
          ? state!.segments.filter((x) => x.id !== seg.id) // retracted (e.g. speaker echo)
          : upsert(state!.segments, seg, (s) => s.startMs)
    })
  )
  api.on('response', (r: AssistantResponse) => {
    pendingDeltas.delete(r.id)
    set({ responses: upsert(state!.responses, r) })
  })
  api.on('response-delta', ({ id, delta }) => {
    pendingDeltas.set(id, (pendingDeltas.get(id) ?? '') + delta)
    requestAnimationFrame(applyDeltas)
  })
  api.on('questions', (questions) => set({ questions }))
  api.on('snapshot', (s: ScreenSnapshot) => set({ snapshots: capSnapshots(upsert(state!.snapshots, s)) }))
  api.on('summary', (summary) => set({ summary }))
  api.on('levels', (levels) => set({ levels }))
  api.on('settings', (settings) => {
    set({ settings })
    applyAppearance(settings.ui)
  })
  api.on('credentials', (credentials) => set({ credentials }))
  api.on('devices', (devices) => set({ devices }))
  api.on('session-reset', (snap) =>
    set({ ...snap, toasts: state!.toasts, levels: state!.levels, loaded: true })
  )
  api.on('toast', (t) => pushToast(t))
  api.on('theme', (theme) => applyTheme(theme))
}

export function pushToast(t: Toast): void {
  if (!state) return
  set({ toasts: [...state.toasts.filter((x) => x.message !== t.message), t].slice(-4) })
  const ttl = t.level === 'error' ? 9000 : 6000
  setTimeout(() => dismissToast(t.id), ttl)
}

export function dismissToast(id: string): void {
  if (!state) return
  set({ toasts: state.toasts.filter((t) => t.id !== id) })
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Select a slice of the live state; re-renders only when that slice changes identity. */
export function useStore<T>(selector: (s: UiState) => T): T | undefined {
  return useSyncExternalStore(subscribe, () => (state ? selector(state) : undefined))
}

export function getState(): UiState | null {
  return state
}
