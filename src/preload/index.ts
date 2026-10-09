import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CAPTURE_RECEIVE_CHANNELS,
  CAPTURE_SEND_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS
} from '@shared/ipc'

// The sandboxed preload exposes a narrow, whitelisted API. ipcRenderer itself is never exposed.
const invokeSet = new Set<string>(INVOKE_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)
const captureSend = new Set<string>(CAPTURE_SEND_CHANNELS)
const captureReceive = new Set<string>(CAPTURE_RECEIVE_CHANNELS)

function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('mycluely', {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!invokeSet.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(event: string, cb: (payload: unknown) => void): () => void {
    if (!eventSet.has(event)) throw new Error(`Blocked event: ${event}`)
    return subscribe(`evt:${event}`, cb)
  },
  capture: {
    send(channel: string, payload: unknown): void {
      if (!captureSend.has(channel)) throw new Error(`Blocked capture channel: ${channel}`)
      ipcRenderer.send(channel, payload)
    },
    on(channel: string, cb: (payload: unknown) => void): () => void {
      if (!captureReceive.has(channel)) throw new Error(`Blocked capture channel: ${channel}`)
      return subscribe(channel, cb)
    }
  }
})
