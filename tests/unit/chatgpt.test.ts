import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatGPTPlanProvider } from '../../src/main/providers/chatgpt'
import type { ChatRequest } from '../../src/main/providers/types'
import { ChatGPTAuth } from '../../src/main/services/chatgpt-auth'
import type { Encryptor } from '../../src/main/services/credential-store'
import { startChatGPTMock, type ChatGPTMock } from '../helpers/mock-chatgpt'

const encryptor: Encryptor = {
  isAvailable: async () => true,
  encrypt: async (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: async (b) => ({ value: Buffer.from(b.toString().slice(4), 'base64').toString(), shouldReEncrypt: false })
}

let dir: string
let mock: ChatGPTMock

/** The "browser": follow the authorize redirect to our loopback callback, like a user approving. */
const browser = async (url: string): Promise<void> => {
  void fetch(url).catch(() => undefined)
}

function auth(): ChatGPTAuth {
  return new ChatGPTAuth({ dir, encryptor, openUrl: browser, issuer: mock.url, resource: `${mock.url}/v1`, redirectPort: 0, appName: 'MyCluely' })
}

function chat(over: Partial<ChatRequest> = {}): ChatRequest & { deltas: string[] } {
  const deltas: string[] = []
  return {
    model: 'gpt-6.1-sol',
    system: 'SYSTEM',
    user: 'What was asked?',
    maxOutputTokens: 512,
    effort: 'low',
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    onDelta: (d) => deltas.push(d),
    deltas,
    ...over
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mycluely-chatgpt-'))
  mock = await startChatGPTMock()
})
afterEach(async () => {
  await mock.close()
  await rm(dir, { recursive: true, force: true })
})

describe('Sign in with ChatGPT', () => {
  it('registers, signs in with PKCE and stores an encrypted session', async () => {
    const a = auth()
    await a.init()
    const status = await a.signIn()
    expect(status).toMatchObject({ signedIn: true, planUsage: true, email: 'sam@example.com' })
    expect(a.credentialStatus()).toMatchObject({ configured: true, source: 'stored', account: 'sam@example.com' })

    const p = mock.authorizeRequests[0]
    expect(p.get('client_id')).toBe('dynamic_agent_client')
    expect(p.get('agent_name_hint')).toBe('MyCluely')
    expect(p.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('resource')).toBe(`${mock.url}/v1`)
    expect(p.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)

    const client = JSON.parse(await readFile(path.join(dir, 'chatgpt-client.json'), 'utf8'))
    expect(client.clientId).toBe('oaiapp_mock1')
    const sessionFile = await readFile(path.join(dir, 'chatgpt-session.json'), 'utf8')
    expect(sessionFile).not.toContain('at_')
    expect(sessionFile).not.toContain('rt_')

    // Survives a restart.
    const again = auth()
    await again.init()
    expect(again.status()).toMatchObject({ signedIn: true, planUsage: true })
  })

  it('reuses the registered client and host on later sign-ins, and revokes on sign-out', async () => {
    const a = auth()
    await a.init()
    await a.signIn()
    const host = mock.authorizeRequests[0].get('ext_agent_host_id')
    const { revoked } = await a.signOut()
    expect(revoked).toBe(true)
    expect(mock.revoked).toHaveLength(1)
    expect(a.status().signedIn).toBe(false)
    await a.signIn()
    const second = mock.authorizeRequests[1]
    expect(second.get('client_id')).toBe('oaiapp_mock1')
    expect(second.get('agent_name_hint')).toBeNull()
    expect(second.get('login_hint')).toBe('sam@example.com')
    expect(second.get('ext_agent_host_id')).toBe(host)
    // "Switch account" forgets the client so the next sign-in registers again.
    await a.signOut(true)
    await a.signIn()
    expect(mock.authorizeRequests[2].get('client_id')).toBe('dynamic_agent_client')
  })

  it('refreshes expiring tokens once even with concurrent callers, rotating the refresh token', async () => {
    mock.options.expiresIn = 30 // inside the refresh margin
    const a = auth()
    await a.init()
    await a.signIn()
    const [t1, t2] = await Promise.all([a.accessToken(), a.accessToken()])
    expect(t1).toBe(t2)
    const refreshes = mock.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0].get('client_id')).toBe('oaiapp_mock1')
    expect(refreshes[0].get('resource')).toBe(`${mock.url}/v1`)
    await a.accessToken() // uses the rotated refresh token (old one would be "reused")
    expect(a.status().signedIn).toBe(true)
  })

  it('signs out cleanly when the refresh grant is no longer valid', async () => {
    mock.options.expiresIn = 30
    const a = auth()
    await a.init()
    await a.signIn()
    await mock.close()
    mock = await startChatGPTMock() // new server: old refresh tokens unknown → invalid_grant
    const b = new ChatGPTAuth({ dir, encryptor, openUrl: browser, issuer: mock.url, resource: `${mock.url}/v1`, redirectPort: 0 })
    await b.init()
    // Issuer moved, so discovery/ID-token checks would differ; simulate by refreshing against the new mock.
    await expect(b.accessToken()).rejects.toThrow()
    expect(b.status().signedIn).toBe(false)
    expect(b.status().problem).toMatch(/sign in again/i)
  })

  it('reports a denied consent and a consent without plan usage', async () => {
    mock.options.consent = 'deny'
    const a = auth()
    await a.init()
    await expect(a.signIn()).rejects.toThrow(/cancelled in the browser/)
    expect(a.status().signedIn).toBe(false)
    mock.options.consent = 'no-plan'
    const st = await a.signIn()
    expect(st).toMatchObject({ signedIn: true, planUsage: false })
    expect(a.credentialStatus().configured).toBe(false)
    expect(st.problem).toMatch(/plan usage was not allowed/)
  })

  it('rejects an ID token that is not signed by the issuer', async () => {
    mock.options.badSignature = true
    const a = auth()
    await a.init()
    await expect(a.signIn()).rejects.toThrow(/Could not verify/)
    expect(a.status().signedIn).toBe(false)
  })
})

describe('ChatGPT plan provider', () => {
  async function signedIn(): Promise<{ a: ChatGPTAuth; p: ChatGPTPlanProvider }> {
    const a = auth()
    await a.init()
    await a.signIn()
    return { a, p: new ChatGPTPlanProvider(a, { baseURL: `${mock.url}/v1` }) }
  }

  it('lists only models offered to the account', async () => {
    const { p } = await signedIn()
    const models = await p.listModels()
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(models[0]).toMatchObject({ displayName: 'GPT-6.1 Sol', provider: 'chatgpt' })
  })

  it('streams answers through the Responses API with store:false', async () => {
    const { p } = await signedIn()
    const req = chat()
    const r = await p.stream(req)
    expect(r.text).toBe('Answered with your ChatGPT plan.')
    expect(req.deltas.length).toBe(2)
    const body = mock.responsesBodies[0] as Record<string, unknown>
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('SYSTEM')
  })

  it('drops an unsupported screenshot and retries with screen text only', async () => {
    mock.options.rejectImages = true
    const { p } = await signedIn()
    const r = await p.stream(chat({ image: { mimeType: 'image/jpeg', base64: 'AAAA' } }))
    expect(r.text).toBe('Answered with your ChatGPT plan.')
    expect(r.notes?.join(' ')).toMatch(/screen text only/)
    expect(mock.responsesBodies).toHaveLength(2)
    expect(JSON.stringify(mock.responsesBodies[1])).not.toContain('input_image')
  })

  it('explains plan limits and eligibility with actionable messages', async () => {
    const { p } = await signedIn()
    const failure = async (): Promise<{ kind: string; userMessage: string }> => {
      try {
        await p.stream(chat())
      } catch (e) {
        return e as { kind: string; userMessage: string }
      }
      throw new Error('expected the request to fail')
    }
    mock.options.failNext = { code: 'subscription_sharing_usage_limit_exceeded', status: 429, count: 1 }
    const limit = await failure()
    expect(limit.kind).toBe('quota')
    expect(limit.userMessage).toMatch(/chatgpt\.com\/settings\/usage/)
    mock.options.failNext = { code: 'subscription_sharing_user_not_eligible', status: 403, count: 1 }
    const ineligible = await failure()
    expect(ineligible.kind).toBe('permission')
    expect(ineligible.userMessage).toMatch(/Plus or Pro/)
    mock.options.failMidStream = 'subscription_sharing_usage_limit_exceeded'
    expect((await failure()).kind).toBe('quota')
  })

  it('refreshes once and retries when the access token is rejected', async () => {
    const { p } = await signedIn()
    mock.expireAccessTokens()
    const r = await p.stream(chat())
    expect(r.text).toBe('Answered with your ChatGPT plan.')
    expect(mock.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })
})
