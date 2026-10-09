import { Agent, setGlobalDispatcher } from 'undici'

const KEEP_ALIVE_MS = 60_000
const WARM_THROTTLE_MS = 20_000

/**
 * Keep HTTPS connections to the AI providers open between requests. Node's fetch closes idle
 * connections after 4 s, so in a meeting — where requests are seconds apart — almost every answer
 * paid for a new TCP + TLS handshake (about 0.4 s on a 180 ms round trip). The provider SDKs all
 * use the global fetch, so one dispatcher covers them. `undici` is pinned to the version bundled
 * with Electron's Node.
 */
export function keepConnectionsAlive(): void {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: 5 * 60_000, connect: { timeout: 15_000 } }))
}

const lastWarm = new Map<string, number>()

/**
 * Open a connection to `origin` ahead of a likely request (meeting start, a question was just
 * asked), so the request itself skips the handshake. Cheap, throttled, and never throws.
 */
export function warmConnection(origin: string): void {
  const now = Date.now()
  if (now - (lastWarm.get(origin) ?? 0) < WARM_THROTTLE_MS) return
  lastWarm.set(origin, now)
  void fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).then(
    (r) => r.body?.cancel(),
    () => undefined
  )
}
