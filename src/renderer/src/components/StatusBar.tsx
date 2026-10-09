import { useEffect, useState, type ReactNode } from 'react'
import type { ModelInfo, ProviderId } from '@shared/types'
import { PROVIDER_IDS, PROVIDER_LABELS } from '@shared/types'
import { api } from '../lib/api'
import { safe } from '../lib/actions'
import { useStore } from '../lib/store'
import { Meter } from './common'
import { IconBot, IconMic, IconMonitor, IconSpeaker, IconWave } from './icons'

const ENGINE_LABEL: Record<string, string> = {
  local: 'On-device Whisper',
  openai: 'OpenAI',
  gemini: 'Gemini',
  none: 'Off',
  auto: 'Auto'
}

export function ModelSwitcher({ compact }: { compact?: boolean }): ReactNode {
  const settings = useStore((s) => s.settings)
  const credentials = useStore((s) => s.credentials)
  const [models, setModels] = useState<ModelInfo[]>([])
  const provider = settings?.ai.provider ?? 'anthropic'
  const model = settings?.ai.models[provider] ?? ''
  const configured = !!credentials?.[provider]?.configured

  useEffect(() => {
    let alive = true
    if (!configured) {
      setModels([])
      return
    }
    void api.invoke('providers:models', provider).then(
      (m) => alive && setModels(m),
      () => alive && setModels([])
    )
    return () => {
      alive = false
    }
  }, [provider, configured])

  if (!settings) return null
  const setProvider = (p: ProviderId): void => void safe(() => api.invoke('settings:update', { ai: { provider: p } }))
  const setModel = (m: string): void => void safe(() => api.invoke('settings:update', { ai: { models: { [provider]: m } } }))
  const options = models.some((m) => m.id === model) ? models : [{ id: model, displayName: model } as ModelInfo, ...models]
  return (
    <span className="row" style={{ gap: 6 }}>
      {!compact && <IconBot className="muted" />}
      <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} aria-label="AI provider" style={compact ? { maxWidth: 132 } : undefined}>
        {PROVIDER_IDS.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABELS[p]}
            {credentials?.[p]?.configured ? '' : p === 'chatgpt' ? ' (not connected)' : ' (no key)'}
          </option>
        ))}
      </select>
      <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" style={{ maxWidth: compact ? 118 : 220 }}>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id}
          </option>
        ))}
      </select>
    </span>
  )
}

export function StatusBar(): ReactNode {
  const status = useStore((s) => s.status)
  const levels = useStore((s) => s.levels)
  if (!status || !levels) return null
  const live = status.session === 'running'
  const t = status.transcription
  return (
    <div className="statusbar" data-testid="statusbar">
      <span className={`status-item${status.mic.error ? ' err' : ''}`} title={status.mic.error ?? status.mic.label ?? ''}>
        <IconMic />
        {status.mic.enabled ? (
          <>
            <span className="ellipsis" style={{ maxWidth: 160 }}>You{status.mic.label && status.mic.active ? ` · ${status.mic.label}` : ''}</span>
            <Meter level={levels.mic} speaking={levels.micSpeaking} active={live && status.mic.active} />
            {status.mic.error && <span>⚠</span>}
          </>
        ) : (
          <span className="muted">Mic off</span>
        )}
      </span>
      <span className={`status-item${status.system.error ? ' err' : ''}`} title={status.system.error ?? 'Audio playing on this PC (Teams, Zoom, Meet, …)'}>
        <IconSpeaker />
        {status.system.enabled ? (
          <>
            <span>Meeting audio</span>
            <Meter level={levels.system} speaking={levels.systemSpeaking} active={live && status.system.active} />
            {status.system.error && <span>⚠</span>}
          </>
        ) : (
          <span className="muted">System audio off</span>
        )}
      </span>
      <span className={`status-item${status.screen.error ? ' err' : ''}`} title={status.screen.error ?? ''}>
        <IconMonitor />
        <span className="ellipsis" style={{ maxWidth: 200 }}>
          {status.screen.sourceName ?? 'No screen selected'}
          {status.screen.region ? ' (region)' : ''}
        </span>
        {status.screen.auto && <span className="badge">auto {status.screen.intervalSec}s</span>}
        {status.screen.busy && <span className="badge accent">capturing</span>}
      </span>
      <span className={`status-item${!t.ok ? ' err' : ''}`} title={t.error ?? t.detail ?? ''}>
        <IconWave />
        <span>{ENGINE_LABEL[t.engine] ?? t.engine}</span>
        {t.pending > 0 && <span className="badge">{t.pending} pending</span>}
        {t.detail && <span className="muted ellipsis" style={{ maxWidth: 220 }}>{t.detail}</span>}
        {!t.ok && <span className="ellipsis" style={{ maxWidth: 260 }}>⚠ {t.error}</span>}
      </span>
      <span className="spacer" />
      <span className="status-item">
        <ModelSwitcher />
        {status.ai.configured ? (
          status.ai.vision ? <span className="badge ok" title="This model can see screenshots">vision</span> : <span className="badge" title="Screen text (OCR) only">text only</span>
        ) : (
          <button onClick={() => void api.invoke('window:show-main', 'settings')}>{status.ai.provider === 'chatgpt' ? 'connect ChatGPT' : 'add API key'}</button>
        )}
      </span>
    </div>
  )
}
