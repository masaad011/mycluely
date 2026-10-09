import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DeepPartial, Settings } from '@shared/settings'
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from '@shared/settings'
import { ACCENTS, FONTS, THEMES, type ThemeId, type ThemePreference } from '@shared/themes'
import type { ModelInfo, ProviderId, ProviderTestResult, ShortcutAction } from '@shared/types'
import { MEETING_MODES, PROVIDER_IDS, PROVIDER_LABELS, RESPONSE_STYLES, SHORTCUT_LABELS } from '@shared/types'
import { RECOMMENDED_TRANSCRIPTION_MODELS, visionOverrideKey } from '@shared/models'
import { api } from '../lib/api'
import { safe } from '../lib/actions'
import { pushToast, useStore } from '../lib/store'
import { accelLabel, Modal, Segmented } from '../components/common'
import { IconCheck, IconExternal, IconRefresh } from '../components/icons'

type KeyProvider = Exclude<ProviderId, 'chatgpt'>

const PROVIDER_INFO: Record<
  KeyProvider,
  { keys: string; billing: string; note: string; subscription: string; placeholder: string; extra?: { label: string; url: string } }
> = {
  openai: {
    keys: 'https://platform.openai.com/api-keys',
    billing: 'https://platform.openai.com/account/billing/overview',
    note: 'Pay-as-you-go API billing. Also powers cloud transcription.',
    subscription: 'Have ChatGPT Plus or Pro? Use “ChatGPT plan” above instead — no API key and no API charges for answers.',
    placeholder: 'sk-…'
  },
  anthropic: {
    keys: 'https://platform.claude.com/settings/keys',
    billing: 'https://platform.claude.com/settings/billing',
    note: 'Claude API billing (prepaid credits).',
    subscription:
      'Claude Pro/Max subscriptions can’t be used here: Anthropic only allows them in its own apps (claude.ai, Claude Code), so an API key is required.',
    placeholder: 'sk-ant-…'
  },
  gemini: {
    keys: 'https://aistudio.google.com/api-keys',
    billing: 'https://aistudio.google.com/billing',
    note: 'Google AI Studio key. Can also transcribe audio.',
    subscription:
      'No subscription needed: a free-tier key works (rate-limited; Google may use free-tier prompts to improve its products). Google AI Pro/Ultra subscribers can also claim monthly Google Cloud credits that cover Gemini API usage.',
    placeholder: 'AIza…',
    extra: { label: 'AI Pro/Ultra credits', url: 'https://ai.google.dev/gemini-api/docs/google-ai-plans' }
  },
  moonshot: {
    keys: 'https://platform.kimi.ai/console/api-keys',
    billing: 'https://platform.kimi.ai/console/account',
    note: 'Kimi Open Platform key (minimum $1 recharge). International and China platforms use different keys.',
    subscription: 'Kimi membership and Kimi Code keys are limited to coding tools, so an Open Platform key is required here.',
    placeholder: 'sk-…'
  },
  deepseek: {
    keys: 'https://platform.deepseek.com/api_keys',
    billing: 'https://api-docs.deepseek.com/quick_start/pricing',
    note: 'DeepSeek Open Platform key (prepaid top-up). Flash reads screenshots; V4-Pro uses screen text only.',
    subscription:
      'DeepSeek has no paid subscription: the chat app is free and the API is prepaid per use, so a key is required. It is very cheap (Flash is about $0.15 per million input tokens off-peak), with lower prices outside peak hours.',
    placeholder: 'sk-…'
  }
}

const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

function ChatGPTCard(): ReactNode {
  const cred = useStore((s) => s.credentials.chatgpt)
  const settings = useStore((s) => s.settings)
  const [busy, setBusy] = useState<'' | 'signin' | 'test' | 'signout'>('')
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  if (!settings) return null
  const signedIn = cred?.source === 'stored'
  const active = settings.ai.provider === 'chatgpt'
  const signIn = async (): Promise<void> => {
    setBusy('signin')
    setResult(null)
    const status = await safe(() => api.invoke('chatgpt:sign-in'), 'ChatGPT sign-in')
    setBusy('')
    if (status?.chatgpt.configured) {
      // If the selected provider can't be used (no key), answer with the plan straight away.
      const switchNow = !status[settings.ai.provider]?.configured
      if (switchNow) update({ ai: { provider: 'chatgpt' } })
      pushToast({
        id: `chatgpt-${Date.now()}`,
        level: 'success',
        message: `Connected to ChatGPT${status.chatgpt.account ? ` as ${status.chatgpt.account}` : ''}.`,
        detail: switchNow ? 'Answers now use your ChatGPT plan.' : 'Select “ChatGPT plan” as the provider to answer with your plan.',
        at: Date.now()
      })
      setResult((await safe(() => api.invoke('providers:test', 'chatgpt'))) ?? null)
    }
  }
  const test = async (): Promise<void> => {
    setBusy('test')
    setResult((await safe(() => api.invoke('providers:test', 'chatgpt'))) ?? null)
    setBusy('')
  }
  const signOut = async (forget: boolean): Promise<void> => {
    setBusy('signout')
    const r = await safe(() => api.invoke('chatgpt:sign-out', forget))
    setBusy('')
    setResult(null)
    if (r && !r.revoked) {
      pushToast({
        id: `signout-${Date.now()}`,
        level: 'warning',
        message: 'Signed out on this PC.',
        detail: 'Remote revocation was not confirmed — you can also disconnect MyCluely in ChatGPT settings.',
        at: Date.now()
      })
    }
  }
  return (
    <div className="card provider-card" data-testid="provider-chatgpt">
      <h3>
        ChatGPT plan (Plus / Pro)
        {cred?.configured ? (
          <span className="badge ok">
            <IconCheck width={12} height={12} /> connected
          </span>
        ) : (
          <span className="badge">{signedIn ? 'plan usage off' : 'not connected'}</span>
        )}
        {active && <span className="badge accent">active</span>}
      </h3>
      <div className="small muted">
        Use your ChatGPT Plus or Pro plan for answers — no API key and no API charges. Requests count against your plan’s usage (you can cap
        MyCluely’s share in ChatGPT settings). Transcription isn’t included; it uses on-device Whisper or another engine.
      </div>
      {cred?.problem && <div className="callout warn">{cred.problem}</div>}
      {signedIn ? (
        <div className="row wrap">
          <input
            type="text"
            className="grow"
            readOnly
            value={`Signed in as ${cred?.account ?? 'your ChatGPT account'}`}
            aria-label="ChatGPT account"
            data-testid="chatgpt-account"
          />
          <button className="btn" type="button" onClick={() => void test()} disabled={!!busy}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn" type="button" onClick={() => void signOut(false)} disabled={!!busy}>
            Sign out
          </button>
          {!cred?.configured && (
            <button className="btn primary" type="button" onClick={() => void signIn()} disabled={!!busy}>
              Allow plan usage
            </button>
          )}
        </div>
      ) : busy === 'signin' ? (
        <div className="row wrap">
          <span className="grow small">Finish signing in in your browser, then come back here…</span>
          <button className="btn" type="button" onClick={() => void api.invoke('chatgpt:cancel')}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn primary" type="button" onClick={() => void signIn()} data-testid="chatgpt-sign-in">
            Continue with ChatGPT
          </button>
          <span className="small muted">Opens your browser to sign in and approve “Use your ChatGPT plan”.</span>
        </div>
      )}
      {result && (
        <div className={`callout${result.ok ? '' : ' warn'}`} role="status">
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </div>
      )}
      <div className="row small wrap">
        <button className="link row" onClick={() => open(CHATGPT_USAGE_URL)}>
          Manage usage <IconExternal width={12} height={12} />
        </button>
        {signedIn && (
          <>
            <span className="muted">·</span>
            <button className="link" onClick={() => void signOut(true)}>
              Switch account
            </button>
          </>
        )}
        <span className="spacer" />
        {cred?.configured && !active && (
          <button className="btn sm primary" onClick={() => update({ ai: { provider: 'chatgpt' } })} data-testid="use-chatgpt">
            Use ChatGPT plan for answers
          </button>
        )}
      </div>
    </div>
  )
}

type Section = 'providers' | 'model' | 'transcription' | 'audio' | 'screen' | 'assistant' | 'privacy' | 'shortcuts' | 'appearance'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'providers', label: 'API keys & providers' },
  { id: 'model', label: 'AI model' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'audio', label: 'Audio capture' },
  { id: 'screen', label: 'Screen capture' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'appearance', label: 'Appearance' }
]

const DEFAULT_UI = DEFAULT_SETTINGS.ui

function update(patch: DeepPartial<Settings>): void {
  void safe(() => api.invoke('settings:update', patch), 'Could not save settings')
}

function open(url: string): void {
  void safe(() => api.invoke('shell:open-external', url))
}

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="field">
      <div className="label">{label}</div>
      <div className="control">
        {children}
        {help && <div className="help">{help}</div>}
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
  return (
    <label className="row">
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** Text input that saves on blur / Enter. */
function LazyInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  width
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  type?: string
  width?: number
}): ReactNode {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function ProviderCard({ id }: { id: KeyProvider }): ReactNode {
  const cred = useStore((s) => s.credentials[id])
  const settings = useStore((s) => s.settings)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const info = PROVIDER_INFO[id]
  if (!settings) return null
  const saved = !!cred?.configured && cred.source === 'stored'
  const editing = !cred?.configured || replacing
  const save = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    const ok = await safe(() => api.invoke('credentials:set', id, key.trim()), 'Could not save key')
    if (ok) {
      setKey('')
      setReplacing(false)
      pushToast({
        id: `key-${id}-${Date.now()}`,
        level: 'success',
        message: `${PROVIDER_LABELS[id]} key saved securely.`,
        detail: 'It is remembered after you restart MyCluely — no need to enter it again.',
        at: Date.now()
      })
      setResult((await safe(() => api.invoke('providers:test', id))) ?? null)
    }
    setBusy(false)
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    setResult((await safe(() => api.invoke('providers:test', id))) ?? null)
    setBusy(false)
  }
  return (
    <div className="card provider-card" data-testid={`provider-${id}`}>
      <h3>
        {PROVIDER_LABELS[id]}
        {cred?.configured ? (
          <span className="badge ok">
            <IconCheck width={12} height={12} /> {cred.source === 'env' ? 'from environment' : 'key saved'}
          </span>
        ) : (
          <span className="badge">not configured</span>
        )}
        {settings.ai.provider === id && <span className="badge accent">active</span>}
      </h3>
      <div className="small muted">{info.note}</div>
      <div className="small muted" data-testid={`subscription-note-${id}`}>
        {info.subscription}
      </div>
      {cred?.problem && <div className="callout warn">{cred.problem}</div>}
      {!editing ? (
        <div className="row wrap">
          <input
            type="text"
            className="grow"
            readOnly
            value={`••••••••••••••••${cred?.hint ?? ''}`}
            aria-label={`${PROVIDER_LABELS[id]} API key (saved)`}
            data-testid={`saved-key-${id}`}
          />
          <button className="btn" type="button" onClick={() => setReplacing(true)}>
            Replace key
          </button>
          <button className="btn" type="button" onClick={() => void test()} disabled={busy}>
            {busy ? 'Testing…' : 'Test connection'}
          </button>
          {saved && (
            <button className="btn danger" type="button" onClick={() => void safe(() => api.invoke('credentials:clear', id))}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            type="password"
            className="grow"
            autoComplete="off"
            spellCheck={false}
            autoFocus={replacing}
            placeholder={`Paste your API key (${info.placeholder})`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={`${PROVIDER_LABELS[id]} API key`}
          />
          <button className="btn primary" type="submit" disabled={!key.trim() || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {replacing && (
            <button className="btn" type="button" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
      {!editing && (
        <div className="small muted">
          {cred?.source === 'env'
            ? 'Read from an environment variable. Save a key here to override it.'
            : 'Saved securely on this PC (encrypted with your Windows account) and remembered after restart.'}
        </div>
      )}
      {result && (
        <div className={`callout${result.ok ? '' : ' warn'}`} role="status">
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </div>
      )}
      <div className="row small wrap">
        <button className="link row" onClick={() => open(info.keys)}>
          Get an API key <IconExternal width={12} height={12} />
        </button>
        <span className="muted">·</span>
        <button className="link row" onClick={() => open(info.billing)}>
          Billing <IconExternal width={12} height={12} />
        </button>
        {info.extra && (
          <>
            <span className="muted">·</span>
            <button className="link row" onClick={() => open(info.extra!.url)}>
              {info.extra.label} <IconExternal width={12} height={12} />
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="link" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
      </div>
      {advanced && (
        <div className="col">
          {id === 'moonshot' && (
            <label className="row small">
              Platform
              <select value={settings.ai.moonshotRegion} onChange={(e) => update({ ai: { moonshotRegion: e.target.value as 'global' | 'cn' } })}>
                <option value="global">International (api.moonshot.ai)</option>
                <option value="cn">China (api.moonshot.cn)</option>
              </select>
            </label>
          )}
          <label className="col small">
            Custom base URL (optional — proxies or compatible gateways)
            <LazyInput
              value={settings.ai.baseUrls[id] ?? ''}
              placeholder="Leave empty for the official endpoint"
              onCommit={(v) => update({ ai: { baseUrls: { ...settings.ai.baseUrls, [id]: v.trim() || undefined } } })}
            />
          </label>
        </div>
      )}
    </div>
  )
}

function ModelSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const credentials = useStore((s) => s.credentials)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const provider = settings?.ai.provider ?? 'anthropic'
  const configured = !!credentials?.[provider]?.configured
  const latest = useRef(0)
  const load = async (refresh: boolean): Promise<void> => {
    const req = ++latest.current
    if (!configured) return setModels([])
    setLoading(true)
    setError('')
    try {
      const list = await api.invoke('providers:models', provider, refresh)
      if (req === latest.current) setModels(list) // ignore answers for a provider no longer selected
    } catch (err) {
      if (req !== latest.current) return
      setError(String((err as Error).message).replace(/^Error invoking remote method '[^']+': /, ''))
      setModels([])
    }
    if (req === latest.current) setLoading(false)
  }
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, configured])
  if (!settings) return null
  const model = settings.ai.models[provider]
  const info = models.find((m) => m.id === model)
  const overrideKey = visionOverrideKey(provider, model)
  const override = settings.ai.visionOverrides[overrideKey]
  const vision = override ?? info?.vision
  return (
    <div className="settings-section">
      <h2>AI model</h2>
      <Field label="Provider" help="You can switch provider or model at any time — even mid-meeting. The transcript and context are kept by the app, not the provider.">
        <select value={provider} onChange={(e) => update({ ai: { provider: e.target.value as ProviderId } })} data-testid="provider-select">
          {PROVIDER_IDS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
              {credentials?.[p]?.configured ? '' : p === 'chatgpt' ? ' — not connected' : ' — no API key'}
            </option>
          ))}
        </select>
        {!configured && (
          <div className="callout warn">
            {provider === 'chatgpt'
              ? 'Connect your ChatGPT plan with “Continue with ChatGPT” under “API keys & providers”.'
              : `Add an API key for ${PROVIDER_LABELS[provider]} under “API keys & providers”.`}
          </div>
        )}
      </Field>
      <Field
        label="Model"
        help={
          <>
            The list is fetched live from {PROVIDER_LABELS[provider]}. Recommended models are listed first. You can also type any model id the
            provider supports.
          </>
        }
      >
        <div className="model-row">
          <select value={models.some((m) => m.id === model) ? model : ''} onChange={(e) => e.target.value && update({ ai: { models: { [provider]: e.target.value } } })} disabled={!models.length}>
            {!models.some((m) => m.id === model) && <option value="">{model} (not in list)</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName !== m.id ? `${m.displayName} — ${m.id}` : m.id}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void load(true)} disabled={!configured || loading}>
            <IconRefresh /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <LazyInput value={model} placeholder="Model id" onCommit={(v) => v.trim() && update({ ai: { models: { [provider]: v.trim() } } })} />
        {error && <div className="callout warn">{error}</div>}
        <div className="row wrap small">
          {vision === undefined ? <span className="badge">vision unknown</span> : vision ? <span className="badge ok">image input</span> : <span className="badge">text only (uses OCR)</span>}
          {info?.contextWindow && <span className="badge">{Math.round(info.contextWindow / 1000)}K context</span>}
          {info?.maxOutputTokens && <span className="badge">{Math.round(info.maxOutputTokens / 1000)}K max output</span>}
          {info && <span className="muted">capabilities from {info.visionSource === 'api' ? 'provider metadata' : 'model name'}</span>}
        </div>
        <label className="row small">
          Image input
          <select
            value={override === undefined ? 'auto' : override ? 'yes' : 'no'}
            onChange={(e) => {
              const next = { ...settings.ai.visionOverrides }
              if (e.target.value === 'auto') delete next[overrideKey]
              else next[overrideKey] = e.target.value === 'yes'
              update({ ai: { visionOverrides: next } })
            }}
          >
            <option value="auto">Detect automatically</option>
            <option value="yes">Model supports images</option>
            <option value="no">Model is text-only</option>
          </select>
        </label>
      </Field>
      <Field
        label="Response speed"
        help={
          settings.ai.speed === 'fast'
            ? 'Fastest: answers start straight away — the model writes without extended thinking, and screenshots go only with “Explain this screen” (the screen text is always included). Best for live meetings.'
            : 'Balanced: Detailed and Technical answers think first, and screenshots are also sent when screen text is hard to read. Better for complex questions, but answers take a few seconds longer to start.'
        }
      >
        <Segmented
          title="Response speed"
          value={settings.ai.speed}
          options={[
            { id: 'fast', label: 'Fastest' },
            { id: 'balanced', label: 'Balanced' }
          ]}
          onChange={(v) => update({ ai: { speed: v } })}
        />
      </Field>
      <Field label="Send screenshots" help="OCR text is always included. Images give vision models diagrams and layout, but add latency and cost.">
        <select value={settings.ai.imagePolicy} onChange={(e) => update({ ai: { imagePolicy: e.target.value as Settings['ai']['imagePolicy'] } })}>
          <option value="auto">
            {settings.ai.speed === 'fast'
              ? 'Automatic — for “Explain this screen” (at Balanced speed, also when screen text is hard to read)'
              : 'Automatic — for “Explain this screen”, and whenever screen text is hard to read (recommended)'}
          </option>
          <option value="explain">Only for “Explain this screen”</option>
          <option value="always">With every request (when recent)</option>
          <option value="never">Never — OCR text only</option>
        </select>
      </Field>
      <Field label="Max context per request" help="Upper bound for transcript + screen + notes sent with each request. Older discussion is summarised automatically.">
        <select value={settings.ai.maxContextTokens} onChange={(e) => update({ ai: { maxContextTokens: Number(e.target.value) } })}>
          {[8000, 16000, 24000, 48000, 96000, 200000].map((n) => (
            <option key={n} value={n}>
              {n / 1000}K tokens
            </option>
          ))}
        </select>
      </Field>
      <Field label="Max response length">
        <select value={settings.ai.maxOutputTokens} onChange={(e) => update({ ai: { maxOutputTokens: Number(e.target.value) } })}>
          {[1024, 2048, 4096, 8192, 16000].map((n) => (
            <option key={n} value={n}>
              {n} tokens
            </option>
          ))}
        </select>
      </Field>
      <Field label="Request timeout">
        <select value={settings.ai.requestTimeoutSec} onChange={(e) => update({ ai: { requestTimeoutSec: Number(e.target.value) } })}>
          {[30, 60, 90, 180, 300].map((n) => (
            <option key={n} value={n}>
              {n} s
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function TranscriptionSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const credentials = useStore((s) => s.credentials)
  const status = useStore((s) => s.status.transcription)
  if (!settings) return null
  const t = settings.transcription
  const modelField = (engine: 'openai' | 'gemini' | 'local'): ReactNode => {
    const key = engine === 'openai' ? 'openaiModel' : engine === 'gemini' ? 'geminiModel' : 'localModel'
    const list = RECOMMENDED_TRANSCRIPTION_MODELS[engine]
    const value = t[key]
    return (
      <div className="row wrap">
        <select value={list.includes(value) ? value : '__custom'} onChange={(e) => e.target.value !== '__custom' && update({ transcription: { [key]: e.target.value } })}>
          {list.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__custom">Custom…</option>
        </select>
        <LazyInput value={value} width={280} onCommit={(v) => v.trim() && update({ transcription: { [key]: v.trim() } })} />
      </div>
    )
  }
  return (
    <div className="settings-section">
      <h2>Transcription</h2>
      <Field
        label="Engine"
        help={
          <>
            <b>Auto</b> uses OpenAI if a key is set, otherwise Gemini, otherwise on-device Whisper. On-device Whisper is free and private; it
            downloads a model (~80–250 MB) from Hugging Face on first use and runs on your GPU (WebGPU) or CPU.
          </>
        }
      >
        <select value={t.engine} onChange={(e) => update({ transcription: { engine: e.target.value as Settings['transcription']['engine'] } })}>
          <option value="auto">Auto (recommended)</option>
          <option value="local">On-device Whisper (no key needed)</option>
          <option value="openai" disabled={!credentials?.openai.configured}>
            OpenAI{credentials?.openai.configured ? '' : ' — needs key'}
          </option>
          <option value="gemini" disabled={!credentials?.gemini.configured}>
            Google Gemini{credentials?.gemini.configured ? '' : ' — needs key'}
          </option>
          <option value="none">Off</option>
        </select>
        {status && (
          <div className="small muted">
            Currently using: <b>{status.engine}</b> {status.model && `· ${status.model}`} {status.detail && `· ${status.detail}`}
          </div>
        )}
      </Field>
      <Field label="OpenAI model" help="gpt-transcribe is OpenAI's recommended speech-to-text model; gpt-4o-transcribe-diarize adds speaker labels.">
        {modelField('openai')}
      </Field>
      <Field label="Gemini model" help="Any Gemini model with audio input works; Flash-Lite is the fastest and cheapest.">
        {modelField('gemini')}
      </Field>
      <Field label="On-device model" help="“.en” models are English-only and more accurate for English; base is a good balance, small is more accurate but slower.">
        {modelField('local')}
      </Field>
      <Field label="Language" help="ISO code such as en, de, fr, ja. Leave empty to auto-detect (not supported by English-only local models).">
        <LazyInput value={t.language} width={120} placeholder="auto" onCommit={(v) => update({ transcription: { language: v.trim().toLowerCase() } })} />
      </Field>
      <Field
        label="Separate remote speakers"
        help="OpenAI only: uses gpt-4o-transcribe-diarize on meeting audio to split it into Remote A / Remote B. Labels are per segment and may not match across the meeting."
      >
        <Toggle checked={t.diarize} onChange={(v) => update({ transcription: { diarize: v } })} label="Enable speaker separation (diarization)" />
      </Field>
    </div>
  )
}

function AudioSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const devices = useStore((s) => s.devices) ?? []
  if (!settings) return null
  const a = settings.audio
  return (
    <div className="settings-section">
      <h2>Audio capture</h2>
      <Field label="Microphone (You)" help="Your own voice. Use headphones so the microphone doesn't also pick up the other participants (duplicates are filtered, but headphones work best).">
        <Toggle checked={a.micEnabled} onChange={(v) => update({ audio: { micEnabled: v } })} label="Capture my microphone" />
        <select value={a.micDeviceId} onChange={(e) => update({ audio: { micDeviceId: e.target.value } })} disabled={!a.micEnabled}>
          <option value="default">System default microphone</option>
          {devices
            .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
        {!devices.length && <div className="small muted">Device names appear after the first capture (Windows asks for microphone permission).</div>}
      </Field>
      <Field
        label="Meeting audio (Remote)"
        help="Captures what plays through your PC speakers/headset — Teams, Zoom, Google Meet in the browser, etc. — using Windows loopback capture. It records all apps' audio, so mute other media during meetings."
      >
        <Toggle checked={a.systemEnabled} onChange={(v) => update({ audio: { systemEnabled: v } })} label="Capture system audio" />
      </Field>
      <Field label="Speech sensitivity" help="Raise it if quiet speakers are missed; lower it if background noise gets transcribed.">
        <div className="row">
          <span className="small muted">Less</span>
          <input type="range" min={0} max={1} step={0.05} value={a.vadSensitivity} onChange={(e) => update({ audio: { vadSensitivity: Number(e.target.value) } })} />
          <span className="small muted">More</span>
          <span className="badge">{Math.round(a.vadSensitivity * 100)}%</span>
        </div>
      </Field>
      <Field label="Pause before a segment ends" help="Shorter = faster transcripts but more fragmented sentences.">
        <select value={a.minSilenceMs} onChange={(e) => update({ audio: { minSilenceMs: Number(e.target.value) } })}>
          {[400, 550, 700, 900, 1200].map((n) => (
            <option key={n} value={n}>
              {n} ms
            </option>
          ))}
        </select>
      </Field>
      <Field label="Maximum segment length" help="Long monologues are split at natural pauses so text appears regularly.">
        <select value={a.maxSegmentSec} onChange={(e) => update({ audio: { maxSegmentSec: Number(e.target.value) } })}>
          {[8, 10, 14, 20, 28].map((n) => (
            <option key={n} value={n}>
              {n} s
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

function ScreenSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  if (!settings) return null
  const sc = settings.screen
  return (
    <div className="settings-section">
      <h2>Screen capture</h2>
      <Field label="Automatic capture" help="Capture the selected screen, window or region periodically while a meeting is running.">
        <Toggle checked={sc.autoCapture} onChange={(v) => update({ screen: { autoCapture: v } })} label="Capture automatically" />
        <select value={sc.intervalSec} onChange={(e) => update({ screen: { intervalSec: Number(e.target.value) } })}>
          {[5, 10, 20, 30, 60, 120].map((n) => (
            <option key={n} value={n}>
              Every {n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Skip unchanged screens" help="Automatic captures that look the same as the previous one are not processed again.">
        <Toggle checked={sc.skipUnchanged} onChange={(v) => update({ screen: { skipUnchanged: v } })} label="Skip unchanged" />
      </Field>
      <Field label="Text recognition (OCR)" help="Runs locally (Tesseract, English). Needed for text-only models; vision models also receive the image when allowed.">
        <Toggle checked={sc.ocrEnabled} onChange={(v) => update({ screen: { ocrEnabled: v } })} label="Read text on screen" />
      </Field>
    </div>
  )
}

function AssistantSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  if (!settings) return null
  const a = settings.assistant
  return (
    <div className="settings-section">
      <h2>Assistant</h2>
      <Field label="Default meeting type">
        <select value={a.mode} onChange={(e) => update({ assistant: { mode: e.target.value as Settings['assistant']['mode'] } })}>
          {MEETING_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.description}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Default response style">
        <select value={a.style} onChange={(e) => update({ assistant: { style: e.target.value as Settings['assistant']['style'] } })}>
          {RESPONSE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Answering questions"
        help={
          a.autoSuggest === 'answers'
            ? 'Questions asked by other participants — and, when screen watching is on, questions, problems and code shown on the watched screen — are answered automatically as soon as they appear (uses API credits). The screen is read once it stops changing, unchanged content is never answered twice, and MyCluely never types, submits or sends anything. You can still click Answer at any time.'
            : 'Questions asked by other participants are highlighted; click Answer (or press the shortcut) when you want an answer.'
        }
      >
        <Segmented
          title="Answering questions"
          value={a.autoSuggest === 'answers' ? 'answers' : 'questions'}
          options={[
            { id: 'questions', label: 'Manual — I click Answer' },
            { id: 'answers', label: 'Auto — answer automatically' }
          ]}
          onChange={(v) => update({ assistant: { autoSuggest: v } })}
        />
        <Toggle
          checked={a.autoScreen}
          onChange={(v) => update({ assistant: { autoScreen: v } })}
          label="In Auto mode, also watch the selected screen, window or region and answer questions shown there"
        />
        <label className="row small">
          Wait at least
          <select
            value={a.suggestionCooldownSec}
            disabled={a.autoSuggest !== 'answers'}
            onChange={(e) => update({ assistant: { suggestionCooldownSec: Number(e.target.value) } })}
            aria-label="Minimum time between automatic answers"
          >
            {[...new Set([5, 10, 20, 30, 60, a.suggestionCooldownSec])].sort((x, y) => x - y).map((n) => (
              <option key={n} value={n}>
                {n < 60 ? `${n} s` : `${n / 60} min`}
              </option>
            ))}
          </select>
          between automatic answers (a question asked sooner is answered right after)
        </label>
      </Field>
      <Field label="About you" help="Optional: your name and role, so answers are written from your perspective.">
        <LazyInput value={a.userContext} placeholder="e.g. Sam, backend tech lead on the payments team" onCommit={(v) => update({ assistant: { userContext: v } })} />
      </Field>
      <Field label="Custom instructions" help="Added to every request.">
        <CustomInstructions value={a.customInstructions} />
      </Field>
    </div>
  )
}

function CustomInstructions({ value }: { value: string }): ReactNode {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <textarea
      rows={4}
      value={draft}
      placeholder="e.g. Prefer TypeScript examples. Our stack is AWS + Postgres."
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && update({ assistant: { customInstructions: draft } })}
    />
  )
}

function PrivacySection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const [confirm, setConfirm] = useState(false)
  if (!settings) return null
  const p = settings.privacy
  return (
    <div className="settings-section">
      <h2>Privacy & data</h2>
      <div className="callout">
        Audio is never stored: it is transcribed and discarded. API keys are encrypted with Windows' data protection (DPAPI) and never leave the
        main process. Transcripts, screenshots and context are sent only to the providers you configure, when you use them.
      </div>
      <Field label="Meeting history" help="Save transcripts, AI responses and summaries locally so you can review and export them later.">
        <Toggle checked={p.saveHistory} onChange={(v) => update({ privacy: { saveHistory: v } })} label="Save meetings to history" />
      </Field>
      <Field label="Keep history for">
        <select value={p.retentionDays} onChange={(e) => update({ privacy: { retentionDays: Number(e.target.value) } })}>
          {[1, 7, 30, 90, 365, 0].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Forever' : `${n} day${n === 1 ? '' : 's'}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Screenshots" help="By default screenshots are deleted when the meeting ends; only recognised text is kept.">
        <Toggle checked={p.keepScreenshots} onChange={(v) => update({ privacy: { keepScreenshots: v } })} label="Keep screenshots with saved meetings" />
      </Field>
      <Field label="Consent reminder" help="Recording or transcribing others may require their consent. Show a reminder when starting a meeting.">
        <Toggle checked={p.consentReminder} onChange={(v) => update({ privacy: { consentReminder: v } })} label="Remind me to get consent" />
      </Field>
      <Field
        label="Hide from screen sharing"
        help="On by default. When you share your screen or a window (Teams, Zoom, Meet, …), the MyCluely window and assistant panel are excluded from what the other participants see, using Windows display affinity (Windows 10 2004+). Note: some screen-recording and monitoring/proctoring tools ignore this and can still capture the window — treat it as not hidden in those settings."
      >
        <Toggle checked={p.hideFromCapture} onChange={(v) => update({ privacy: { hideFromCapture: v } })} label="Hide MyCluely from screen sharing and screenshots" />
      </Field>
      <Field label="Delete data">
        <div>
          <button className="btn danger" onClick={() => setConfirm(true)}>
            Delete all meeting history…
          </button>
        </div>
      </Field>
      {confirm && (
        <Modal
          title="Delete all meeting history?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirm(false)
                  void safe(() => api.invoke('history:delete-all'))
                }}
              >
                Delete everything
              </button>
            </>
          }
        >
          This permanently deletes every saved transcript, summary and screenshot. This cannot be undone.
        </Modal>
      )}
    </div>
  )
}

function ShortcutsSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const platform = useStore((s) => s.platform)
  if (!settings) return null
  return (
    <div className="settings-section">
      <h2>Keyboard shortcuts</h2>
      <div className="small muted">
        Global shortcuts work even when another app (your meeting) is focused. To avoid hijacking other apps' keys, only “Show / hide
        assistant panel” is active all the time; the others are active only while a meeting is running. Avoid Ctrl+Alt+letter (that is AltGr
        on many keyboard layouts) and your meeting app's own shortcuts (e.g. Teams uses Ctrl+Shift+M to mute). Use Electron accelerator
        syntax, e.g. <kbd>CommandOrControl+Alt+Shift+A</kbd>. Leave empty to disable.
      </div>
      {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((k) => (
        <Field key={k} label={SHORTCUT_LABELS[k]}>
          <div className="row">
            <LazyInput value={settings.shortcuts[k]} width={300} onCommit={(v) => update({ shortcuts: { [k]: v.trim() } })} />
            <kbd>{accelLabel(settings.shortcuts[k], platform) || '—'}</kbd>
          </div>
        </Field>
      ))}
      <div>
        <button className="btn" onClick={() => update({ shortcuts: { ...DEFAULT_SHORTCUTS } })}>
          Restore defaults
        </button>
      </div>
    </div>
  )
}

/** A miniature window drawn with the theme's own colours. */
function ThemePreview({ id }: { id: ThemeId }): ReactNode {
  return (
    <span className="tp" data-theme={id}>
      <span className="tp-nav">
        <i />
        <i />
        <i />
      </span>
      <span className="tp-main">
        <span className="tp-bar" />
        <span className="tp-card">
          <i />
          <i />
        </span>
        <span className="tp-btn" />
      </span>
    </span>
  )
}

function ThemeGallery({ value, onChange }: { value: ThemePreference; onChange: (v: ThemePreference) => void }): ReactNode {
  const cards: { id: ThemePreference; label: string; description: string }[] = [
    { id: 'system', label: 'System', description: 'Light or Dark, following Windows' },
    ...THEMES.map((t) => ({ id: t.id, label: t.label, description: t.description }))
  ]
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Theme">
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          aria-label={c.label}
          className={`theme-card${value === c.id ? ' active' : ''}`}
          onClick={() => onChange(c.id)}
        >
          <span className="tp-frame">
            {c.id === 'system' ? (
              <>
                <ThemePreview id="light" />
                <ThemePreview id="dark" />
              </>
            ) : (
              <ThemePreview id={c.id} />
            )}
          </span>
          <span className="tc-name">
            {c.label}
            {value === c.id && <IconCheck />}
          </span>
          <span className="tc-desc">{c.description}</span>
        </button>
      ))}
    </div>
  )
}

function AppearanceSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  if (!settings) return null
  const u = settings.ui
  const D = DEFAULT_UI
  const isDefault =
    u.theme === D.theme && u.accent === D.accent && u.density === D.density && u.corners === D.corners && u.font === D.font && u.fontScale === D.fontScale
  return (
    <div className="settings-section">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Appearance
        </h2>
        {!isDefault && (
          <button
            className="link small"
            onClick={() => update({ ui: { theme: D.theme, accent: D.accent, density: D.density, corners: D.corners, font: D.font, fontScale: D.fontScale } })}
          >
            Restore default appearance
          </button>
        )}
      </div>
      <Field label="Theme" help="Applies to the main window and the assistant panel. High contrast keeps a single yellow accent for maximum legibility.">
        <ThemeGallery value={u.theme} onChange={(theme) => update({ ui: { theme } })} />
      </Field>
      <Field label="Accent colour" help="Buttons, highlights and focus rings. “Windows accent” uses the colour from Windows Settings → Personalisation, adjusted to stay legible.">
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={u.accent === a.id}
              aria-label={a.label}
              title={a.label}
              data-accent={a.id}
              className={`swatch${u.accent === a.id ? ' active' : ''}`}
              onClick={() => update({ ui: { accent: a.id } })}
            >
              {u.accent === a.id && <IconCheck />}
            </button>
          ))}
          <span className="swatch-name">{ACCENTS.find((a) => a.id === u.accent)?.label}</span>
        </div>
      </Field>
      <Field label="Density" help="Compact fits more transcript and answers on screen.">
        <Segmented
          title="Density"
          value={u.density}
          options={[
            { id: 'comfortable', label: 'Comfortable' },
            { id: 'compact', label: 'Compact' }
          ]}
          onChange={(density) => update({ ui: { density } })}
        />
      </Field>
      <Field label="Corners">
        <Segmented
          title="Corners"
          value={u.corners}
          options={[
            { id: 'rounded', label: 'Rounded' },
            { id: 'square', label: 'Square' }
          ]}
          onChange={(corners) => update({ ui: { corners } })}
        />
      </Field>
      <Field label="Font" help="Fonts that come with Windows. Code and screen text always use a monospaced font.">
        <div className="font-options" role="radiogroup" aria-label="Font">
          {FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={u.font === f.id}
              aria-label={f.label}
              className={u.font === f.id ? 'active' : ''}
              onClick={() => update({ ui: { font: f.id } })}
            >
              <span className="fo-sample" style={{ fontFamily: f.family }}>
                Aa
              </span>
              <span className="fo-name" style={{ fontFamily: f.family }}>
                {f.label}
              </span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Text size">
        <div className="row">
          <input type="range" min={0.85} max={1.4} step={0.05} value={u.fontScale} onChange={(e) => update({ ui: { fontScale: Number(e.target.value) } })} aria-label="Text size" />
          <span className="badge">{Math.round(u.fontScale * 100)}%</span>
        </div>
      </Field>
      <Field label="Assistant panel">
        <Toggle checked={u.overlayAlwaysOnTop} onChange={(v) => update({ ui: { overlayAlwaysOnTop: v } })} label="Keep the panel above other windows" />
        <Toggle checked={u.showOverlayOnStart} onChange={(v) => update({ ui: { showOverlayOnStart: v } })} label="Show the panel when a meeting starts" />
        <Toggle
          checked={u.showOverlayOnAutoAnswer}
          onChange={(v) => update({ ui: { showOverlayOnAutoAnswer: v } })}
          label="Show the panel when an automatic answer arrives (without taking focus)"
        />
      </Field>
      <Field label="Panel opacity">
        <div className="row">
          <input type="range" min={0.4} max={1} step={0.02} value={u.overlayOpacity} onChange={(e) => update({ ui: { overlayOpacity: Number(e.target.value) } })} aria-label="Panel opacity" />
          <span className="badge">{Math.round(u.overlayOpacity * 100)}%</span>
        </div>
      </Field>
    </div>
  )
}

export function SettingsView(): ReactNode {
  const [section, setSection] = useState<Section>('providers')
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Settings</h1>
        <div className="muted small" style={{ marginBottom: 18 }}>
          Changes are saved automatically.
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
            <button className="link small" style={{ marginTop: 12, textAlign: 'left', padding: '0 10px' }} onClick={() => void safe(() => api.invoke('settings:reset'))}>
              Reset all settings
            </button>
          </nav>
          <div>
            {section === 'providers' && (
              <div className="settings-section">
                <h2>API keys & providers</h2>
                <div className="small muted">
                  Connect a ChatGPT Plus/Pro plan, or bring your own API keys (each provider bills API usage directly). Claude, Gemini app and Kimi
                  subscriptions can’t be used by other apps, and DeepSeek has no subscription — each card shows the cheapest option. Keys and sign-ins are stored encrypted with your
                  Windows account.
                </div>
                <ChatGPTCard />
                {(PROVIDER_IDS.filter((p) => p !== 'chatgpt') as KeyProvider[]).map((id) => (
                  <ProviderCard key={id} id={id} />
                ))}
              </div>
            )}
            {section === 'model' && <ModelSection />}
            {section === 'transcription' && <TranscriptionSection />}
            {section === 'audio' && <AudioSection />}
            {section === 'screen' && <ScreenSection />}
            {section === 'assistant' && <AssistantSection />}
            {section === 'privacy' && <PrivacySection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'appearance' && <AppearanceSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
