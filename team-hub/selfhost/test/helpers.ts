import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../src/constants'
import type { OutboundTransport } from '../../src/outbound'
import { loadConfig, SESSION_KEY_ENV } from '../src/config'
import { createHub, type Hub } from '../src/server'
import type { SqliteDatabase } from '../src/db'

/**
 * The suite talks to the service the way a client does: real HTTP over a real
 * loopback port, a real SQLite file on disk, real WebSocket handshakes. The one
 * seam is outbound HTTP (GitHub, APNs, the account service), which is the same
 * TEAM_HUB_OUTBOUND injection the Worker suite uses.
 */

export const BOOTSTRAP_TOKEN = 'test-bootstrap-token'
export const ACCOUNT_JWKS_URL = 'https://account.example/jwks.json'
export const ACCOUNT_ISSUER = 'https://account.example'
export const ACCOUNT_AUDIENCE = 'dsh-team-hub'
export const ACCOUNT_SUB = 'acct_hubot'

export interface GithubAccount {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

export const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
export const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface RecordedTransport {
  calls: RecordedCall[]
  transport: OutboundTransport
}

function headerObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = String(value)
    })
    return out
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers)
  for (const [key, value] of entries) out[key.toLowerCase()] = String(value)
  return out
}

export interface FakeOptions {
  accounts?: GithubAccount[]
  /** JWKS document the account service publishes; absent means "not configured". */
  jwks?: unknown
}

/** Contract-shaped fake of GitHub, the account service and APNs, recording calls. */
export function fakeServices(options: FakeOptions = {}): RecordedTransport {
  const accounts = options.accounts ?? [OCTOCAT, HUBOT]
  const byLogin = new Map(accounts.map((account) => [account.login.toLowerCase(), account]))
  const byCode = new Map<string, GithubAccount>()
  const calls: RecordedCall[] = []
  const transport: OutboundTransport = async (url, init) => {
    const call: RecordedCall = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: headerObject(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    }
    calls.push(call)
    const parsed = new URL(call.url)
    if (parsed.host === 'github.com' && parsed.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(call.body)
      const code = form.get('code') ?? ''
      const account = byLogin.get(code.toLowerCase())
      if (account === undefined) return Response.json({ error: 'bad_verification_code' }, { status: 200 })
      byCode.set('gho_' + code, account)
      return Response.json({ access_token: 'gho_' + code, token_type: 'bearer', scope: 'read:user' }, { status: 200 })
    }
    if (parsed.host === 'api.github.com' && parsed.pathname === '/user') {
      const account = byCode.get((call.headers.authorization ?? '').replace(/^Bearer /i, ''))
      if (account === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 })
      return Response.json(account, { status: 200 })
    }
    if (parsed.host === 'api.github.com' && parsed.pathname.startsWith('/users/')) {
      const login = decodeURIComponent(parsed.pathname.slice('/users/'.length)).toLowerCase()
      const account = byLogin.get(login)
      if (account === undefined) return Response.json({ message: 'Not Found' }, { status: 404 })
      return Response.json(account, { status: 200 })
    }
    if (parsed.host === 'account.example') {
      if (options.jwks === undefined) return Response.json({ error: 'not_configured' }, { status: 503 })
      return Response.json(options.jwks)
    }
    if (parsed.host === 'api.push.apple.com' || parsed.host === 'api.sandbox.push.apple.com') {
      return new Response(null, { status: 200 })
    }
    return Response.json({ message: 'unexpected outbound host ' + parsed.host }, { status: 404 })
  }
  return { calls, transport }
}

export interface StartOptions {
  env?: Record<string, string | undefined>
  accounts?: GithubAccount[]
  jwks?: unknown
}

export interface TestHub {
  hub: Hub
  baseUrl: string
  sqlite: SqliteDatabase
  calls: RecordedCall[]
  close(): Promise<void>
}

export async function startTestHub(options: StartOptions = {}): Promise<TestHub> {
  const directory = mkdtempSync(join(tmpdir(), 'team-hub-selfhost-'))
  const fake = fakeServices({ accounts: options.accounts, jwks: options.jwks })
  const environment: Record<string, string | undefined> = {
    DATABASE_PATH: join(directory, 'hub.sqlite'),
    HOST: '127.0.0.1',
    PORT: '0',
    SWEEP_INTERVAL_MS: '0',
    [SESSION_KEY_ENV]: 'test-session-signing-key',
    BOOTSTRAP_TOKEN,
    GITHUB_CLIENT_ID: 'test-github-client-id',
    GITHUB_CLIENT_SECRET: 'test-github-client-secret',
    ACCOUNT_JWKS_URL,
    ACCOUNT_ISSUER,
    ACCOUNT_AUDIENCE,
    ...options.env,
  }
  const report = loadConfig(environment)
  if (report.errors.length > 0) throw new Error('test configuration is invalid: ' + report.errors.join('; '))
  const hub = await createHub({ config: report.config, outbound: fake.transport, log: () => undefined })
  const address = await hub.listen()
  return {
    hub,
    baseUrl: address.url,
    sqlite: hub.database.sqlite,
    calls: fake.calls,
    async close() {
      await hub.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export interface ApiOptions {
  token?: string
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  omitProtocol?: boolean
}

export interface ApiResult {
  status: number
  body: any
  headers: Headers
  text: string
}

/** One real HTTP call against the running service. */
export async function api(
  hub: TestHub,
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const url = new URL(path, hub.baseUrl)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const headers = new Headers()
  if (options.omitProtocol !== true) headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION)
  if (options.token !== undefined) headers.set('authorization', 'Bearer ' + options.token)
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  if (payload !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(url, { method, headers, redirect: 'manual', body: payload })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, headers: response.headers, text }
}

export interface Frame {
  t: string
  seq?: number
  event?: string
  payload?: any
  reason?: string
  latest_seq?: number
  ts?: number
}

export class FrameQueue {
  readonly frames: Frame[] = []
  readonly observed: string[] = []
  readonly closed: { code: number; reason: string }[] = []
  #waiting: ((frame: Frame) => void)[] = []
  #closeWaiters: ((value: { code: number; reason: string }) => void)[] = []

  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Frame
      if (frame.event !== undefined) this.observed.push(frame.event)
      const waiter = this.#waiting.shift()
      if (waiter) waiter(frame)
      else this.frames.push(frame)
    })
    socket.on('close', (code, reason) => {
      const closed = { code, reason: Buffer.from(reason).toString('utf8') }
      const waiter = this.#closeWaiters.shift()
      if (waiter) waiter(closed)
      else this.closed.push(closed)
    })
  }

  async next(): Promise<Frame> {
    const queued = this.frames.shift()
    if (queued) return queued
    return new Promise<Frame>((resolve) => this.#waiting.push(resolve))
  }

  async collect(count: number): Promise<Frame[]> {
    const out: Frame[] = []
    for (let index = 0; index < count; index += 1) out.push(await this.next())
    return out
  }

  async nextClose(): Promise<{ code: number; reason: string }> {
    const queued = this.closed.shift()
    if (queued) return queued
    return new Promise((resolve) => this.#closeWaiters.push(resolve))
  }
}

export interface SocketOptions {
  token?: string
  query?: Record<string, string>
  headers?: Record<string, string>
  omitProtocol?: boolean
}

export type SocketResult =
  | { ok: true; status: 101; socket: WebSocket; queue: FrameQueue }
  | { ok: false; status: number; body: any }

/** Open the team channel; a refused handshake answers a status and JSON body. */
export async function openSocket(hub: TestHub, teamId: string, options: SocketOptions = {}): Promise<SocketResult> {
  const url = new URL('/api/v1/teams/' + teamId + '/ws', hub.baseUrl)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const headers: Record<string, string> = {}
  if (options.omitProtocol !== true) headers[PROTOCOL_HEADER] = PROTOCOL_VERSION
  if (options.token !== undefined) headers.authorization = 'Bearer ' + options.token
  for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value
  const socket = new WebSocket(url.toString().replace(/^http/, 'ws'), { headers })
  return new Promise<SocketResult>((resolve, reject) => {
    socket.once('open', () => resolve({ ok: true, status: 101, socket, queue: new FrameQueue(socket) }))
    socket.once('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        resolve({ ok: false, status: response.statusCode ?? 0, body })
      })
    })
    socket.once('error', reject)
  })
}

export function randomBase64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export interface Session {
  accessToken: string
  refreshToken: string
  member: any
}

/** The full iOS PKCE flow, through the real authorize, callback and token routes. */
export async function login(hub: TestHub, username: string): Promise<Session> {
  const verifier = 'verifier-for-' + username + '-0123456789abcdef'
  const state = randomBase64url(32)
  const authorize = await api(hub, 'GET', '/auth/github/authorize', {
    query: {
      client: 'ios',
      redirect_uri: 'whale://auth/callback',
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    },
  })
  if (authorize.status !== 302) throw new Error('authorize failed: ' + authorize.status + ' ' + authorize.text)
  const callback = await api(hub, 'GET', '/auth/github/callback', { query: { code: username, state } })
  if (callback.status !== 302) throw new Error('callback failed: ' + callback.status + ' ' + callback.text)
  const token = await api(hub, 'POST', '/auth/token', {
    body: { code: username, code_verifier: verifier, redirect_uri: 'whale://auth/callback' },
  })
  if (token.status !== 200) throw new Error('token exchange failed: ' + token.status + ' ' + token.text)
  return {
    accessToken: token.body.access_token as string,
    refreshToken: token.body.refresh_token as string,
    member: token.body.member,
  }
}

export interface SeededTeam {
  teamId: string
  admin: Session
}

/** Create the first team through the bootstrap endpoint and sign its admin in. */
export async function seedTeam(hub: TestHub): Promise<SeededTeam> {
  const created = await api(hub, 'POST', '/api/v1/bootstrap', {
    headers: { 'X-Bootstrap-Token': BOOTSTRAP_TOKEN },
    body: { team_name: 'Team Test', team_slug: 'team-test', github_username: 'octocat' },
  })
  if (created.status !== 201) throw new Error('bootstrap failed: ' + created.status + ' ' + created.text)
  const admin = await login(hub, 'octocat')
  return { teamId: created.body.team.id as string, admin }
}

/** Invite a second member by GitHub username and sign them in. */
export async function inviteAndLogin(hub: TestHub, teamId: string, adminToken: string, username: string): Promise<Session> {
  const invited = await api(hub, 'POST', '/api/v1/teams/' + teamId + '/members/invite', {
    token: adminToken,
    body: { github_username: username, role: 'member' },
  })
  if (invited.status !== 201) throw new Error('invite failed: ' + invited.status + ' ' + invited.text)
  return login(hub, username)
}

export interface SeededHost {
  hostId: string
  hostToken: string
  agents: { id: string; name: string }[]
}

/** Mint a host token and register the host through the public routes. */
export async function seedHost(
  hub: TestHub,
  teamId: string,
  adminToken: string,
  options: { hostname: string; agents: { name: string; preset_id: string }[] },
): Promise<SeededHost> {
  const minted = await api(hub, 'POST', '/api/v1/teams/' + teamId + '/hosts/tokens', {
    token: adminToken,
    body: { hostname: options.hostname },
  })
  if (minted.status !== 201) throw new Error('host token mint failed: ' + minted.status + ' ' + minted.text)
  const registered = await api(hub, 'POST', '/api/v1/teams/' + teamId + '/hosts/register', {
    token: minted.body.host_token as string,
    body: { hostname: options.hostname, client_version: '1.0.0', agents: options.agents },
  })
  if (registered.status !== 200) throw new Error('host registration failed: ' + registered.status + ' ' + registered.text)
  return {
    hostId: minted.body.host_id as string,
    hostToken: minted.body.host_token as string,
    agents: registered.body.agents as { id: string; name: string }[],
  }
}

export async function createIssue(
  hub: TestHub,
  teamId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<any> {
  const created = await api(hub, 'POST', '/api/v1/teams/' + teamId + '/issues', { token, body })
  if (created.status !== 201) throw new Error('issue creation failed: ' + created.status + ' ' + created.text)
  return created.body.issue
}

export function one<T>(hub: TestHub, sql: string, ...values: (string | number | null)[]): T | null {
  const row = hub.sqlite.prepare(sql).get(...(values as never[])) as T | undefined
  return row ?? null
}

export function all<T>(hub: TestHub, sql: string, ...values: (string | number | null)[]): T[] {
  return hub.sqlite.prepare(sql).all(...(values as never[])) as T[]
}

export interface AccountKey {
  kid: string
  privateKey: CryptoKey
  publicJwk: JsonWebKey
}

/** A real P-256 key pair: assertions are signed and verified for real. */
export async function accountKey(kid = 'account-test-kid'): Promise<AccountKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return { kid, privateKey: pair.privateKey, publicJwk }
}

export function accountJwks(key: AccountKey): { keys: Record<string, string>[] } {
  return {
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        kid: key.kid,
        alg: 'ES256',
        x: key.publicJwk.x as string,
        y: key.publicJwk.y as string,
      },
    ],
  }
}

export interface AssertionOptions {
  sub?: string
  kid?: string
  iss?: string
  aud?: string
  /** Issued-at instant in milliseconds; defaults to the current clock. */
  now?: number
  /** Lifetime in seconds; a negative value is already expired. */
  ttl?: number
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Sign one ES256 assertion with the claims the account service issues. */
export async function accountAssertion(key: AccountKey, options: AssertionOptions = {}): Promise<string> {
  const iat = Math.floor((options.now ?? Date.now()) / 1000)
  const header = { alg: 'ES256', typ: 'JWT', kid: options.kid ?? key.kid }
  const claims = {
    iss: options.iss ?? ACCOUNT_ISSUER,
    aud: options.aud ?? ACCOUNT_AUDIENCE,
    sub: options.sub ?? ACCOUNT_SUB,
    name: 'Account Holder',
    iat,
    exp: iat + (options.ttl ?? 300),
    jti: randomBytes(8).toString('hex'),
  }
  const signingInput = encode(header) + '.' + encode(claims)
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return signingInput + '.' + Buffer.from(signature).toString('base64url')
}

/** Bind the account to a signed-in member through the real link route. */
export async function bindAccount(hub: TestHub, token: string, key: AccountKey, sub = ACCOUNT_SUB): Promise<void> {
  const linked = await api(hub, 'POST', '/auth/account/link', {
    token,
    body: { assertion: await accountAssertion(key, { sub }) },
  })
  if (linked.status !== 200) throw new Error('account link failed: ' + linked.status + ' ' + linked.text)
}
