import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for "Sign in with ChatGPT": OpenID discovery, authorize (with dynamic client
 * registration and PKCE), token/refresh with rotation, JWKS, revocation, and the plan-usage
 * Responses API (`/v1/models`, `/v1/responses`) including its documented error codes.
 * Issuer = `${url}`, resource/API base = `${url}/v1`.
 */
export interface ChatGPTMockOptions {
  /** Browser outcome: approve (default), deny, or approve without plan usage. */
  consent?: 'approve' | 'deny' | 'no-plan'
  expiresIn?: number
  email?: string
  sub?: string
  /** Sign ID tokens with a key that is not in the JWKS. */
  badSignature?: boolean
  /** Reject screenshots with subscription_sharing_unsupported_capability. */
  rejectImages?: boolean
  /** Fail the next N /v1/responses calls with this error code (before streaming). */
  failNext?: { code: string; status: number; count: number }
  /** Fail mid-stream with response.failed and this code. */
  failMidStream?: string
}

export interface ChatGPTMock {
  url: string
  options: ChatGPTMockOptions
  authorizeRequests: URLSearchParams[]
  tokenRequests: URLSearchParams[]
  revoked: string[]
  responsesBodies: Record<string, unknown>[]
  modelRequests: number
  /** Invalidate all access tokens (forces the client to refresh). */
  expireAccessTokens(): void
  close(): Promise<void>
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

function jwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const body = b64url(JSON.stringify(payload))
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key)
  return `${header}.${body}.${b64url(sig)}`
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startChatGPTMock(options: ChatGPTMockOptions = {}): Promise<ChatGPTMock> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const kid = 'mock-key-1'
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' }
  const codes = new Map<string, { clientId: string; challenge: string; nonce: string; redirectUri: string; scope: string }>()
  const refreshTokens = new Map<string, { clientId: string; scope: string; used: boolean }>()
  const accessTokens = new Set<string>()
  let clientCounter = 0
  let tokenCounter = 0
  const state: ChatGPTMock = {
    url: '',
    options,
    authorizeRequests: [],
    tokenRequests: [],
    revoked: [],
    responsesBodies: [],
    modelRequests: 0,
    expireAccessTokens: () => accessTokens.clear(),
    close: async () => undefined
  }

  const issue = (clientId: string, scope: string, nonce?: string): Record<string, unknown> => {
    const n = ++tokenCounter
    const access = `at_${n}_${randomBytes(6).toString('hex')}`
    const refresh = `rt_${n}_${randomBytes(6).toString('hex')}`
    accessTokens.add(access)
    refreshTokens.set(refresh, { clientId, scope, used: false })
    const now = Math.floor(Date.now() / 1000)
    const idToken = jwt(
      {
        iss: state.url,
        aud: clientId,
        sub: state.options.sub ?? 'user-123',
        email: state.options.email ?? 'sam@example.com',
        iat: now,
        exp: now + 3600,
        ...(nonce ? { nonce } : {})
      },
      state.options.badSignature ? rogue : createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })),
      kid
    )
    return { access_token: access, refresh_token: refresh, id_token: idToken, token_type: 'Bearer', expires_in: state.options.expiresIn ?? 3600, scope }
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const o = state.options
    if (u.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: state.url,
        authorization_endpoint: `${state.url}/authorize`,
        token_endpoint: `${state.url}/oauth/token`,
        jwks_uri: `${state.url}/jwks`,
        revocation_endpoint: `${state.url}/revoke`
      })
    }
    if (u.pathname === '/jwks') return json(res, 200, { keys: [jwk] })
    if (u.pathname === '/authorize') {
      const p = u.searchParams
      state.authorizeRequests.push(p)
      const redirect = new URL(p.get('redirect_uri') ?? '')
      redirect.searchParams.set('state', p.get('state') ?? '')
      if (o.consent === 'deny') {
        redirect.searchParams.set('error', 'access_denied')
      } else {
        const clientId = p.get('client_id') === 'dynamic_agent_client' ? `oaiapp_mock${++clientCounter}` : (p.get('client_id') ?? '')
        const scope = o.consent === 'no-plan' ? 'openid profile email offline_access' : (p.get('scope') ?? '')
        const code = `code_${randomBytes(8).toString('hex')}`
        codes.set(code, { clientId, challenge: p.get('code_challenge') ?? '', nonce: p.get('nonce') ?? '', redirectUri: p.get('redirect_uri') ?? '', scope })
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('client_id', clientId)
        redirect.searchParams.set('scope', scope)
      }
      res.writeHead(302, { location: redirect.toString() })
      return res.end()
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      state.tokenRequests.push(form)
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!c || c.challenge !== challenge || c.redirectUri !== form.get('redirect_uri') || c.clientId !== form.get('client_id')) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Bad code exchange' })
        }
        return json(res, 200, issue(c.clientId, c.scope, c.nonce))
      }
      if (form.get('grant_type') === 'refresh_token') {
        const r = refreshTokens.get(form.get('refresh_token') ?? '')
        if (!r || r.clientId !== form.get('client_id')) return json(res, 400, { error: 'invalid_grant' })
        if (r.used) return json(res, 400, { error: 'refresh_token_reused' })
        r.used = true
        const t = issue(r.clientId, r.scope)
        delete t.id_token
        return json(res, 200, t)
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (u.pathname === '/revoke' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      state.revoked.push(form.get('token') ?? '')
      refreshTokens.delete(form.get('token') ?? '')
      res.writeHead(200)
      return res.end()
    }

    // ---- plan-usage API
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (u.pathname.startsWith('/v1/') && !accessTokens.has(auth)) {
      return json(res, 401, { error: { code: 'subscription_sharing_invalid_user', message: 'Invalid user token' } })
    }
    if (u.pathname === '/v1/models') {
      state.modelRequests++
      return json(res, 200, {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
          { slug: 'internal-eval', display_name: 'Internal', visibility: 'hide' }
        ]
      })
    }
    if (u.pathname === '/v1/responses' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      state.responsesBodies.push(body)
      if (o.failNext && o.failNext.count > 0) {
        o.failNext.count--
        return json(res, o.failNext.status, { error: { code: o.failNext.code, message: `mock ${o.failNext.code}`, param: null } })
      }
      const hasImage = JSON.stringify(body).includes('"input_image"')
      if (o.rejectImages && hasImage) {
        return json(res, 400, {
          error: { code: 'subscription_sharing_unsupported_capability', param: 'input[0].content[1].input_image', message: 'Images are not supported' }
        })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let seq = 0
      const send = (type: string, data: Record<string, unknown>): void => {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
      }
      send('response.created', { response: { id: 'resp_plan', object: 'response', status: 'in_progress', output: [] } })
      if (o.failMidStream) {
        send('response.failed', { response: { id: 'resp_plan', status: 'failed', error: { code: o.failMidStream, message: 'limit' } } })
        return res.end()
      }
      for (const chunk of ['Answered with ', 'your ChatGPT plan.']) {
        send('response.output_text.delta', { item_id: 'msg', output_index: 0, content_index: 0, delta: chunk, logprobs: [] })
      }
      send('response.completed', { response: { id: 'resp_plan', object: 'response', status: 'completed', output: [] } })
      return res.end()
    }
    json(res, 404, { detail: `mock: no route ${req.method} ${u.pathname}` })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
    })
  return state
}
