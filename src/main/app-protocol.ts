import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

/**
 * Content-Security-Policy for production pages. Network access is limited to the Hugging Face
 * hosts used to download the on-device Whisper model; all AI provider calls happen in the main
 * process, never in a renderer.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

/**
 * Serve the built renderer from `app://bundle/…` instead of file://. A real (non-opaque) origin
 * gives the renderers persistent Cache Storage/IndexedDB (Whisper model cache), and the
 * COOP/COEP headers enable cross-origin isolation so the WASM runtime can use threads.
 */
export function handleAppScheme(rendererRoot: string): void {
  const root = path.resolve(rendererRoot)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.resolve(root, rel)
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    if (!res.ok) return new Response('Not found', { status: 404 })
    const headers = new Headers()
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    headers.set('X-Content-Type-Options', 'nosniff')
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP)
    return new Response(res.body, { status: 200, headers })
  })
}
