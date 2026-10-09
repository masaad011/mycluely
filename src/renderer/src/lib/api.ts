import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from '@shared/ipc'

/** Typed access to the preload bridge. */
export const api = {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeMap[K]['args']): Promise<InvokeMap[K]['result']> {
    return window.mycluely.invoke(channel, ...args)
  },
  on<K extends EventChannel>(event: K, cb: (payload: EventMap[K]) => void): () => void {
    return window.mycluely.on(event, cb)
  }
}

/** Strip Electron's "Error invoking remote method 'x': Error: " prefix from IPC errors. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
