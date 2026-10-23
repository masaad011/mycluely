import type { AudioDevice } from './types'

/** Windows lists its default and communications devices as aliases named "Default - X" / "Communications - X". */
const ALIAS_PREFIX = /^(Default|Communications)\s*-\s*/i

export function deviceName(label: string): string {
  return label.replace(ALIAS_PREFIX, '').trim()
}

export interface DeviceSummary {
  /** Physical microphones (no Windows aliases). */
  inputs: AudioDevice[]
  /** Microphone Windows uses by default / for calls (names only). */
  defaultInput?: string
  communicationsInput?: string
  /** Playback device Windows uses by default (what loopback capture records) / for calls. */
  defaultOutput?: string
  communicationsOutput?: string
}

/** Make sense of the device list for Settings: physical inputs plus which devices Windows picks. */
export function summarizeDevices(devices: AudioDevice[]): DeviceSummary {
  const named = (kind: AudioDevice['kind'], id: string): string | undefined => {
    const d = devices.find((x) => x.kind === kind && x.deviceId === id)
    return d ? deviceName(d.label) : undefined
  }
  return {
    inputs: devices.filter((d) => d.kind === 'input' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId),
    defaultInput: named('input', 'default'),
    communicationsInput: named('input', 'communications'),
    defaultOutput: named('output', 'default'),
    communicationsOutput: named('output', 'communications')
  }
}
