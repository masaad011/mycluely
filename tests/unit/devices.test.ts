import { describe, expect, it } from 'vitest'
import { deviceName, summarizeDevices } from '../../src/shared/devices'
import type { AudioDevice } from '../../src/shared/types'

const dev = (kind: AudioDevice['kind'], deviceId: string, label: string): AudioDevice => ({ kind, deviceId, label, isDefault: deviceId === 'default' })

// What Chromium reports on a Windows laptop with a USB headset plugged in.
const WINDOWS: AudioDevice[] = [
  dev('input', 'default', 'Default - Microphone Array (Intel® Smart Sound Technology for Digital Microphones)'),
  dev('input', 'communications', 'Communications - Microphone (Jabra EVOLVE LINK)'),
  dev('input', 'a1', 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)'),
  dev('input', 'b2', 'Microphone (Jabra EVOLVE LINK)'),
  dev('input', 'c3', 'Krisp Microphone (Krisp Audio)'),
  dev('output', 'default', 'Default - Speakers (Realtek(R) Audio)'),
  dev('output', 'communications', 'Communications - Headset Earphone (Jabra EVOLVE LINK)'),
  dev('output', 'd4', 'Speakers (Realtek(R) Audio)'),
  dev('output', 'e5', 'Headset Earphone (Jabra EVOLVE LINK)')
]

describe('audio devices', () => {
  it('strips the Windows alias prefixes from device names', () => {
    expect(deviceName('Default - Microphone (USB)')).toBe('Microphone (USB)')
    expect(deviceName('Communications - Headset (Jabra)')).toBe('Headset (Jabra)')
    expect(deviceName('Microphone (USB)')).toBe('Microphone (USB)')
  })

  it('lists physical microphones only, and names what Windows picks by default and for calls', () => {
    const s = summarizeDevices(WINDOWS)
    expect(s.inputs.map((d) => d.deviceId)).toEqual(['a1', 'b2', 'c3'])
    expect(s.defaultInput).toBe('Microphone Array (Intel® Smart Sound Technology for Digital Microphones)')
    expect(s.communicationsInput).toBe('Microphone (Jabra EVOLVE LINK)')
    expect(s.defaultOutput).toBe('Speakers (Realtek(R) Audio)')
    expect(s.communicationsOutput).toBe('Headset Earphone (Jabra EVOLVE LINK)')
  })

  it('never offers playback devices as microphones, even with matching ids', () => {
    const s = summarizeDevices([dev('output', 'x', 'Speakers'), dev('input', 'x', 'Microphone')])
    expect(s.inputs).toHaveLength(1)
    expect(s.inputs[0]!.label).toBe('Microphone')
  })

  it('copes with no communications device (macOS) and with no devices at all', () => {
    const mac = summarizeDevices([dev('input', 'default', 'Default - MacBook Pro Microphone'), dev('input', 'm1', 'MacBook Pro Microphone'), dev('output', 'default', 'Default - MacBook Pro Speakers')])
    expect(mac.communicationsInput).toBeUndefined()
    expect(mac.communicationsOutput).toBeUndefined()
    expect(mac.defaultOutput).toBe('MacBook Pro Speakers')
    expect(summarizeDevices([])).toEqual({ inputs: [], defaultInput: undefined, communicationsInput: undefined, defaultOutput: undefined, communicationsOutput: undefined })
  })
})
