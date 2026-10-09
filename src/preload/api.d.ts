import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from '../shared/ipc'

export interface MyCluelyBridge {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeMap[K]['args']): Promise<InvokeMap[K]['result']>
  on<K extends EventChannel>(event: K, cb: (payload: EventMap[K]) => void): () => void
  capture: {
    send(channel: string, payload: unknown): void
    on(channel: string, cb: (payload: never) => void): () => void
  }
}

declare global {
  interface Window {
    mycluely: MyCluelyBridge
  }
}
