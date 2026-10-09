/// <reference lib="webworker" />
// On-device speech recognition: Whisper (ONNX) via transformers.js, WebGPU when available,
// otherwise multi-threaded WASM. The model is downloaded once from Hugging Face and cached.
import { env, pipeline } from '@huggingface/transformers'
// The ONNX Runtime WebAssembly binary and its loader ship with the app (never fetched from a CDN).
// The loader must stay a separate file: its pthread workers are spawned from the loader's own URL.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

interface TranscribeMsg {
  type: 'transcribe'
  id: string
  model: string
  language?: string
  audio: Float32Array
}

const ctx = self as unknown as DedicatedWorkerGlobalScope
let current: { model: string; transcriber: Transcriber; device: string } | null = null
let loading: Promise<{ model: string; transcriber: Transcriber; device: string }> | null = null

function post(msg: unknown): void {
  ctx.postMessage(msg)
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return 'wasm'
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

async function load(model: string): Promise<{ model: string; transcriber: Transcriber; device: string }> {
  if (current?.model === model) return current
  if (loading) {
    const l = await loading
    if (l.model === model) return l
  }
  loading = (async () => {
    env.allowLocalModels = false
    // The runtime is served locally from app://, which Cache Storage cannot key; models (https) are still cached.
    env.useWasmCache = false
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = {
        wasm: new URL(ortWasmUrl, location.href).href,
        mjs: new URL(ortMjsUrl, location.href).href
      }
      onnx.wasm.numThreads = ctx.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1
    }
    const files = new Map<string, { loaded: number; total: number }>()
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }): void => {
      if (p.status === 'progress' && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        post({ type: 'progress', status: 'loading', progress: total ? (loaded / total) * 100 : undefined })
      }
    }
    post({ type: 'progress', status: 'loading' })
    let device = await pickDevice()
    let transcriber: Transcriber
    try {
      transcriber = (await pipeline('automatic-speech-recognition', model, {
        device,
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback
      })) as unknown as Transcriber
    } catch (err) {
      if (device !== 'webgpu') throw err
      device = 'wasm'
      transcriber = (await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback
      })) as unknown as Transcriber
    }
    current = { model, transcriber, device }
    post({ type: 'progress', status: 'ready', device })
    return current
  })()
  try {
    return await loading
  } catch (err) {
    post({ type: 'progress', status: 'error', message: `Could not load on-device Whisper: ${String((err as Error)?.message ?? err)}` })
    throw err
  } finally {
    loading = null
  }
}

ctx.onmessage = async (e: MessageEvent<TranscribeMsg>) => {
  const msg = e.data
  if (msg?.type !== 'transcribe') return
  try {
    const { transcriber } = await load(msg.model)
    const durationSec = msg.audio.length / 16000
    const out = await transcriber(msg.audio, {
      ...(msg.language ? { language: msg.language, task: 'transcribe' } : {}),
      ...(durationSec > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {})
    })
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
    post({ type: 'result', id: msg.id, text: (text ?? '').trim() })
  } catch (err) {
    post({ type: 'result', id: msg.id, error: String((err as Error)?.message ?? err) })
  }
}
