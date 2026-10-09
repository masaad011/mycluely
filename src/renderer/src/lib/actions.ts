import type { RunActionRequest } from '@shared/ipc'
import type { AssistantAction } from '@shared/types'
import { newId } from '@shared/util'
import { api, errorMessage } from './api'
import { getState, pushToast } from './store'

export function toastError(err: unknown, prefix?: string): void {
  pushToast({ id: newId('t'), level: 'error', message: prefix ? `${prefix}: ${errorMessage(err)}` : errorMessage(err), at: Date.now() })
}

export async function safe<T>(fn: () => Promise<T>, prefix?: string): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    toastError(err, prefix)
    return undefined
  }
}

export function runAction(action: AssistantAction, extra: Omit<RunActionRequest, 'action'> = {}): Promise<string | undefined> {
  return safe(() => api.invoke('assistant:run', { action, ...extra }))
}

/** Start a meeting, showing the consent reminder first when enabled. */
export async function startMeeting(confirmConsent: () => Promise<boolean>, opts: { title?: string } = {}): Promise<void> {
  const s = getState()
  if (s?.settings.privacy.consentReminder && !(await confirmConsent())) return
  await safe(() => api.invoke('session:start', { title: opts.title }), 'Could not start')
}

export const copyText = (text: string): Promise<void | undefined> =>
  safe(async () => {
    await api.invoke('clipboard:write', text)
    pushToast({ id: newId('t'), level: 'success', message: 'Copied to clipboard', at: Date.now() })
  })
