import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { CredentialStatus } from '@shared/types'
import type { Encryptor } from './credential-store'
import { readJson, SerialQueue, writeFileAtomic } from './json-file'

/**
 * "Sign in with ChatGPT" for a local app, following OpenAI's open-source/local flow:
 * OpenID Connect + PKCE through the system browser, a loopback callback on 127.0.0.1, dynamic
 * client registration (`dynamic_agent_client` → issued `oaiapp_…` id), and the
 * `chatgpt.tokens.use.direct` scope so Responses API calls are paid from the user's ChatGPT plan.
 * Docs: https://developers.openai.com/siwc/token-sharing-open-source
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
const CALLBACK_PATH = '/auth/callback'
/** Port required for the initial registration redirect URI. */
const REGISTRATION_PORT = 1455

export interface ChatGPTAuthOptions {
  dir: string
  encryptor: Encryptor
  /** Opens the authorization URL in the user's browser. */
  openUrl: (url: string) => Promise<void> | void
  appName?: string
  issuer?: string
  resource?: string
  redirectPort?: number
  signInTimeoutMs?: number
  fetchImpl?: typeof fetch
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint?: string
}

interface Session {
  clientId: string
  sub: string
  email?: string
  idToken: string
  accessToken: string
  refreshToken?: string
  tokenType: string
  expiresAt: number
  scopes: string[]
  savedAt: number
}

interface ClientRecord {
  clientId: string
  sub?: string
  email?: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

export interface ChatGPTStatus {
  signedIn: boolean
  email?: string
  planUsage: boolean
  problem?: string
}

export class ChatGPTAuthError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'ChatGPTAuthError'
  }
}

const REFRESH_SIGN_IN_AGAIN = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
])

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const CALLBACK_HTML = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#0c0e13;color:#e7eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
  `div{max-width:440px;text-align:center}h1{font-size:20px}</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`

export class ChatGPTAuth {
  private readonly issuer: string
  private readonly resource: string
  private readonly fetch: typeof fetch
  private readonly queue = new SerialQueue()
  private discovery: Discovery | null = null
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null
  private hostId = ''
  private client: ClientRecord | null = null
  private session: Session | null = null
  private problem: string | undefined
  private refreshing: Promise<Session> | null = null
  private signingIn: Promise<ChatGPTStatus> | null = null
  private cancelSignIn: (() => void) | null = null
  private listeners = new Set<() => void>()

  constructor(private readonly opts: ChatGPTAuthOptions) {
    this.issuer = (opts.issuer ?? CHATGPT_ISSUER).replace(/\/+$/, '')
    this.resource = opts.resource ?? CHATGPT_RESOURCE
    this.fetch = opts.fetchImpl ?? fetch
  }

  private file(name: string): string {
    return path.join(this.opts.dir, name)
  }

  /** Load the host id, registered client and encrypted session from disk. */
  async init(): Promise<void> {
    const host = await readJson<{ hostId?: string }>(this.file('chatgpt-host.json'))
    this.hostId = host?.hostId ?? `urn:uuid:${randomUUID()}`
    if (!host?.hostId) await writeFileAtomic(this.file('chatgpt-host.json'), JSON.stringify({ hostId: this.hostId }))
    const client = await readJson<ClientRecord>(this.file('chatgpt-client.json'))
    this.client = client?.clientId ? client : null
    const stored = await readJson<{ cipher?: string }>(this.file('chatgpt-session.json'))
    if (stored?.cipher) {
      try {
        const { value } = await this.opts.encryptor.decrypt(Buffer.from(stored.cipher, 'base64'))
        this.session = JSON.parse(value) as Session
      } catch {
        this.session = null
        this.problem = 'Your saved ChatGPT sign-in could not be decrypted. Please sign in again.'
      }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  status(): ChatGPTStatus {
    const s = this.session
    return {
      signedIn: !!s,
      email: s?.email,
      planUsage: !!s && s.scopes.includes(PLAN_SCOPE),
      problem:
        this.problem ??
        (s && !s.scopes.includes(PLAN_SCOPE)
          ? 'Signed in, but ChatGPT plan usage was not allowed. Sign in again and approve "Use your ChatGPT plan".'
          : undefined)
    }
  }

  credentialStatus(): CredentialStatus {
    const st = this.status()
    return {
      configured: st.signedIn && st.planUsage,
      source: st.signedIn ? 'stored' : 'none',
      account: st.email,
      problem: st.problem
    }
  }

  get signingInNow(): boolean {
    return !!this.signingIn
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const res = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new ChatGPTAuthError(`Could not reach ChatGPT sign-in (${res.status}).`, 'discovery_failed')
    const d = (await res.json()) as Discovery
    const origin = new URL(this.issuer).origin
    const sameOrigin = (u?: string): boolean => !u || new URL(u).origin === origin
    if (
      d.issuer?.replace(/\/+$/, '') !== this.issuer ||
      !d.authorization_endpoint ||
      !d.token_endpoint ||
      !d.jwks_uri ||
      ![d.authorization_endpoint, d.token_endpoint, d.jwks_uri, d.revocation_endpoint].every(sameOrigin)
    ) {
      throw new ChatGPTAuthError('ChatGPT sign-in configuration did not validate.', 'discovery_invalid')
    }
    this.discovery = d
    return d
  }

  /** Run the browser sign-in. Resolves once tokens are verified and stored. */
  signIn(): Promise<ChatGPTStatus> {
    if (this.signingIn) return this.signingIn
    this.signingIn = this.doSignIn().finally(() => {
      this.signingIn = null
      this.cancelSignIn = null
    })
    return this.signingIn
  }

  /** Abort a sign-in that is waiting for the browser. */
  cancel(): void {
    this.cancelSignIn?.()
  }

  private async doSignIn(): Promise<ChatGPTStatus> {
    const d = await this.discover()
    const previous = this.client
    const clientId = previous?.clientId ?? 'dynamic_agent_client'
    const state = b64url(randomBytes(24))
    const nonce = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(48))
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    // Initial registration must use port 1455; later sign-ins may use any free port.
    const preferred = this.opts.redirectPort ?? REGISTRATION_PORT
    const { server, port } = await this.listen(previous ? [preferred, 0] : [preferred])
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: CHATGPT_SCOPES,
      resource: this.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: this.hostId
    })
    if (!previous) params.set('agent_name_hint', this.opts.appName ?? 'MyCluely')
    if (previous?.email) params.set('login_hint', previous.email)

    let callback: { code: string; clientId: string; scope?: string }
    try {
      const waiting = this.awaitCallback(server, port, state, previous?.clientId)
      await this.opts.openUrl(`${d.authorization_endpoint}?${params.toString()}`)
      callback = await waiting
    } finally {
      server.close()
    }

    // Persist the issued client id before the exchange so a failed exchange never registers twice.
    if (!previous || previous.clientId !== callback.clientId) {
      this.client = { clientId: callback.clientId }
      await writeFileAtomic(this.file('chatgpt-client.json'), JSON.stringify(this.client))
    }

    const tokens = await this.tokenRequest(d, {
      grant_type: 'authorization_code',
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: this.resource
    })
    if (!tokens.access_token || !tokens.id_token) {
      throw new ChatGPTAuthError('ChatGPT sign-in did not return the expected tokens.', 'invalid_token_response')
    }
    const claims = await this.verifyIdToken(tokens.id_token, callback.clientId, nonce)
    if (previous?.sub && previous.clientId === callback.clientId && claims.sub !== previous.sub) {
      throw new ChatGPTAuthError(
        'You signed in with a different ChatGPT account. Use "Switch account" to connect another account.',
        'account_mismatch'
      )
    }
    const scopes = (tokens.scope ?? callback.scope ?? '').split(/\s+/).filter(Boolean)
    const session: Session = {
      clientId: callback.clientId,
      sub: claims.sub,
      email: claims.email,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type ?? 'Bearer',
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes,
      savedAt: Date.now()
    }
    this.client = { clientId: callback.clientId, sub: claims.sub, email: claims.email }
    await writeFileAtomic(this.file('chatgpt-client.json'), JSON.stringify(this.client))
    await this.saveSession(session)
    this.problem = undefined
    this.changed()
    return this.status()
  }

  private listen(ports: number[]): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const tryPort = (i: number): void => {
        const server = createServer()
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && i + 1 < ports.length) return tryPort(i + 1)
          reject(
            err.code === 'EADDRINUSE'
              ? new ChatGPTAuthError(
                  `Port ${ports[i]} is busy (another app may be signing in with ChatGPT, e.g. Codex). Close it and try again.`,
                  'port_in_use'
                )
              : err
          )
        })
        server.listen(ports[i], '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
      }
      tryPort(0)
    })
  }

  private awaitCallback(
    server: Server,
    port: number,
    state: string,
    expectedClientId: string | undefined
  ): Promise<{ code: string; clientId: string; scope?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ChatGPTAuthError('Sign-in timed out. Please try again.', 'timeout')),
        this.opts.signInTimeoutMs ?? 5 * 60_000
      )
      this.cancelSignIn = () => {
        clearTimeout(timer)
        reject(new ChatGPTAuthError('Sign-in was cancelled.', 'cancelled'))
      }
      server.on('request', (req, res) => {
        const send = (status: number, title: string, body: string): void => {
          res.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
          })
          res.end(CALLBACK_HTML(title, body))
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end()
          return
        }
        const states = url.searchParams.getAll('state')
        // Unrelated requests must not consume the pending sign-in.
        if (states.length !== 1 || !safeEqual(states[0], state)) return send(400, 'Invalid request', 'This sign-in link is not valid.')
        clearTimeout(timer)
        const error = url.searchParams.get('error')
        if (error) {
          send(200, 'Sign-in cancelled', 'You can close this tab and return to MyCluely.')
          return reject(
            new ChatGPTAuthError(error === 'access_denied' ? 'Sign-in was cancelled in the browser.' : `Sign-in failed: ${error}`, error)
          )
        }
        const codes = url.searchParams.getAll('code')
        const clientId = url.searchParams.get('client_id') ?? expectedClientId
        if (codes.length !== 1 || !clientId || clientId === 'dynamic_agent_client' || (expectedClientId && clientId !== expectedClientId)) {
          send(400, 'Sign-in failed', 'The response from ChatGPT was incomplete. Please try again from MyCluely.')
          return reject(new ChatGPTAuthError('ChatGPT sign-in returned an incomplete response.', 'invalid_callback'))
        }
        send(200, 'Signed in to MyCluely', 'You can close this tab and return to MyCluely.')
        resolve({ code: codes[0], clientId, scope: url.searchParams.get('scope') ?? undefined })
      })
    })
  }

  private async tokenRequest(d: Discovery, form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000)
    })
    let body: TokenResponse = {}
    try {
      body = (await res.json()) as TokenResponse
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || body.error) {
      const code = body.error ?? `http_${res.status}`
      throw new ChatGPTAuthError(body.error_description ?? `Token request failed (${code}).`, code)
    }
    return body
  }

  private async verifyIdToken(idToken: string, clientId: string, nonce?: string): Promise<{ sub: string; email?: string }> {
    const d = await this.discover()
    this.jwks ??= createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 15_000 })
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: d.issuer,
        audience: clientId,
        algorithms: ['RS256'],
        clockTolerance: 5,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub']
      }))
    } catch (err) {
      this.jwks = null // refetch keys next time
      throw new ChatGPTAuthError(`Could not verify the ChatGPT sign-in (${(err as Error).message}).`, 'invalid_id_token')
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw new ChatGPTAuthError('Sign-in token has no subject.', 'invalid_id_token')
    if (nonce && payload.nonce !== nonce) throw new ChatGPTAuthError('Sign-in token nonce mismatch.', 'invalid_id_token')
    if (payload.azp !== undefined && payload.azp !== clientId) throw new ChatGPTAuthError('Sign-in token was issued to another client.', 'invalid_id_token')
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
      throw new ChatGPTAuthError('Sign-in token audience is ambiguous.', 'invalid_id_token')
    }
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined }
  }

  private saveSession(session: Session): Promise<void> {
    this.session = session
    return this.queue.run(async () => {
      const cipher = await this.opts.encryptor.encrypt(JSON.stringify(session))
      await writeFileAtomic(this.file('chatgpt-session.json'), JSON.stringify({ cipher: cipher.toString('base64') }))
    })
  }

  private async clearSession(problem?: string): Promise<void> {
    this.session = null
    this.problem = problem
    await this.queue.run(() => writeFileAtomic(this.file('chatgpt-session.json'), JSON.stringify({})))
    this.changed()
  }

  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(): Promise<string> {
    const s = this.session
    if (!s) throw new ChatGPTAuthError('Not signed in to ChatGPT.', 'not_signed_in')
    if (s.expiresAt - Date.now() > 120_000) return s.accessToken
    return (await this.refresh()).accessToken
  }

  /** Refresh once at a time: a rotating refresh token must never be used twice. */
  refresh(): Promise<Session> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<Session> {
    const s = this.session
    if (!s?.refreshToken) {
      await this.clearSession('Your ChatGPT sign-in expired. Please sign in again.')
      throw new ChatGPTAuthError('ChatGPT sign-in expired.', 'sign_in_required')
    }
    const d = await this.discover()
    let tokens: TokenResponse
    try {
      tokens = await this.tokenRequest(d, {
        grant_type: 'refresh_token',
        client_id: s.clientId,
        refresh_token: s.refreshToken,
        resource: this.resource
      })
    } catch (err) {
      const code = (err as ChatGPTAuthError).code
      if (REFRESH_SIGN_IN_AGAIN.has(code)) {
        await this.clearSession('Your ChatGPT sign-in expired or was disconnected. Please sign in again.')
        throw new ChatGPTAuthError('ChatGPT sign-in expired.', 'sign_in_required')
      }
      throw err // network/server trouble: keep the session and let the caller retry
    }
    if (!tokens.access_token) throw new ChatGPTAuthError('Token refresh returned no access token.', 'invalid_token_response')
    let identity: { sub: string; email?: string } = { sub: s.sub, email: s.email }
    if (tokens.id_token) identity = await this.verifyIdToken(tokens.id_token, s.clientId)
    if (identity.sub !== s.sub) throw new ChatGPTAuthError('Token refresh returned a different account.', 'account_mismatch')
    const next: Session = {
      ...s,
      email: identity.email ?? s.email,
      idToken: tokens.id_token ?? s.idToken,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? s.refreshToken,
      tokenType: tokens.token_type ?? s.tokenType,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : s.scopes,
      savedAt: Date.now()
    }
    await this.saveSession(next)
    return next
  }

  /** The API reported the grant as invalid: try one refresh, otherwise require sign-in again. */
  async handleInvalidUser(): Promise<boolean> {
    try {
      await this.refresh()
      return true
    } catch {
      return false
    }
  }

  /**
   * Sign out: revoke the refresh token (best effort) and forget tokens. The registered client and
   * host id are kept so the next sign-in reuses them; `forgetAccount` drops the client too.
   */
  async signOut(forgetAccount = false): Promise<{ revoked: boolean }> {
    const s = this.session
    let revoked = !s?.refreshToken
    if (s?.refreshToken) {
      try {
        const d = await this.discover()
        if (d.revocation_endpoint) {
          const res = await this.fetch(d.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId }).toString(),
            signal: AbortSignal.timeout(15_000)
          })
          revoked = res.ok
        }
      } catch {
        revoked = false
      }
    }
    if (forgetAccount) {
      this.client = null
      await writeFileAtomic(this.file('chatgpt-client.json'), JSON.stringify({}))
    }
    await this.clearSession()
    return { revoked }
  }
}
