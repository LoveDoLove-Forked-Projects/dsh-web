import { env as workerEnv } from 'cloudflare:workers'
import worker from '../src/index'
import { issueSession } from '../src/auth/session'
import { newId } from '../src/ids'
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../src/constants'
import type { InjectableOutbound, OutboundTransport } from '../src/outbound'
import type { AgentRow, HostRow, MemberRow } from '../src/types'

export type TestEnv = Env & Required<InjectableOutbound>

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function headerObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined) return out
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers)
  for (const [key, value] of entries) out[key.toLowerCase()] = String(value)
  return out
}

export interface RecordedTransport {
  calls: RecordedCall[]
  transport: OutboundTransport
}

/** A fake external service that records the exact requests the Hub sends. */
export function recordingTransport(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedTransport {
  const calls: RecordedCall[] = []
  const transport: OutboundTransport = async (url, init) => {
    const call: RecordedCall = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: headerObject(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, transport }
}

export interface ApiOptions {
  token?: string
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
  omitProtocol?: boolean
  query?: Record<string, string>
}

export interface ApiResult {
  status: number
  body: any
  headers: Headers
  text: string
}

/** Call the Worker through its own fetch entry, exactly as a client would. */
export async function api(env: Env, method: string, path: string, options: ApiOptions = {}): Promise<ApiResult> {
  const url = new URL(path.startsWith('http') ? path : 'https://hub.example' + path)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const headers = new Headers()
  if (options.omitProtocol !== true) headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION)
  if (options.token !== undefined) headers.set('authorization', 'Bearer ' + options.token)
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  if (payload !== undefined) headers.set('content-type', 'application/json')
  const request = new Request(url.toString(), { method, headers, body: payload })
  const response = await worker.fetch(request, env)
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, headers: response.headers, text }
}

/** Call an endpoint that answers with a WebSocket upgrade. */
export async function upgrade(env: Env, path: string, options: ApiOptions = {}): Promise<Response> {
  const url = new URL(path.startsWith('http') ? path : 'https://hub.example' + path)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const headers = new Headers({ Upgrade: 'websocket' })
  if (options.omitProtocol !== true) headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION)
  if (options.token !== undefined) headers.set('authorization', 'Bearer ' + options.token)
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
  return worker.fetch(new Request(url.toString(), { headers }), env)
}

export async function one<T>(env: Env, sql: string, ...values: (string | number | null)[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...values).first<T>()
}

export async function all<T>(env: Env, sql: string, ...values: (string | number | null)[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...values).all<T>()
  return results
}

export interface SeededTeam {
  teamId: string
  admin: MemberRow
  member: MemberRow
}

export const T0 = 1_700_000_000_000

/** Insert a team with an admin and a plain member, both already active. */
export async function seedTeam(env: Env, now: number = T0): Promise<SeededTeam> {
  const teamId = newId('team', now)
  const admin: MemberRow = {
    id: newId('mem', now),
    team_id: teamId,
    github_user_id: 1001,
    github_username: 'octocat',
    display_name: 'Octo Cat',
    avatar_url: null,
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  const member: MemberRow = {
    id: newId('mem', now),
    team_id: teamId,
    github_user_id: 1002,
    github_username: 'hubot',
    display_name: 'Hub Ot',
    avatar_url: null,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(
      teamId,
      'Team Test',
      'team-test-' + teamId,
      now,
      now,
    ),
    env.DB.prepare(
      'INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      admin.id,
      admin.team_id,
      admin.github_user_id,
      admin.github_username,
      admin.display_name,
      admin.avatar_url,
      admin.role,
      admin.status,
      admin.created_at,
      admin.updated_at,
    ),
    env.DB.prepare(
      'INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      member.id,
      member.team_id,
      member.github_user_id,
      member.github_username,
      member.display_name,
      member.avatar_url,
      member.role,
      member.status,
      member.created_at,
      member.updated_at,
    ),
  ])
  return { teamId, admin, member }
}

/** Insert one more active member, for tests that need a third person. */
export async function seedExtraMember(
  env: Env,
  teamId: string,
  options: { githubId: number; username: string; role?: 'admin' | 'member'; now?: number },
): Promise<MemberRow> {
  const now = options.now ?? T0
  const member: MemberRow = {
    id: newId('mem', now),
    team_id: teamId,
    github_user_id: options.githubId,
    github_username: options.username,
    display_name: options.username,
    avatar_url: null,
    role: options.role ?? 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    'INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      member.id,
      member.team_id,
      member.github_user_id,
      member.github_username,
      member.display_name,
      member.avatar_url,
      member.role,
      member.status,
      member.created_at,
      member.updated_at,
    )
    .run()
  return member
}

/** A real session access token for a seeded member. */
export async function tokenFor(env: Env, member: MemberRow, now: number = Date.now()): Promise<string> {
  const session = await issueSession(env, member, now)
  return session.tokens.access_token
}

export interface SeededHost {
  hostId: string
  hostToken: string
  agents: AgentRow[]
}

/** Mint a Host token through the admin API and register the Host through the API. */
export async function seedHost(
  env: Env,
  teamId: string,
  adminToken: string,
  options: { hostname: string; agents: { name: string; preset_id: string }[]; clientVersion?: string },
): Promise<SeededHost> {
  const minted = await api(env, 'POST', '/api/v1/teams/' + teamId + '/hosts/tokens', {
    token: adminToken,
    body: { hostname: options.hostname },
  })
  if (minted.status !== 201) throw new Error('host token mint failed: ' + minted.text)
  const hostToken = minted.body.host_token as string
  const registered = await api(env, 'POST', '/api/v1/teams/' + teamId + '/hosts/register', {
    token: hostToken,
    body: {
      hostname: options.hostname,
      client_version: options.clientVersion ?? '1.0.0',
      agents: options.agents,
    },
  })
  if (registered.status !== 200) throw new Error('host registration failed: ' + registered.text)
  const agents = await all<AgentRow>(env, 'SELECT * FROM agents WHERE team_id = ? ORDER BY name', teamId)
  return { hostId: minted.body.host_id as string, hostToken, agents }
}

export async function findHost(env: Env, teamId: string): Promise<HostRow[]> {
  return all<HostRow>(env, 'SELECT * FROM hosts WHERE team_id = ? ORDER BY created_at', teamId)
}

export type { MemberRow, AgentRow, HostRow }

export interface GithubAccount {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

export interface GithubFakeOptions {
  accounts: GithubAccount[]
  rejectCodes?: string[]
}

/**
 * Contract-shaped fake of the two GitHub endpoints the Hub uses: the OAuth
 * token exchange and the user profile, plus the user lookup the invite route
 * performs.
 */
export function githubHandler(options: GithubFakeOptions): (call: RecordedCall) => Response {
  const byLogin = new Map(options.accounts.map((account) => [account.login.toLowerCase(), account]))
  const byCode = new Map<string, GithubAccount>()
  return (call) => {
    const url = new URL(call.url)
    if (call.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(call.body)
      const code = form.get('code') ?? ''
      const account = byLogin.get(code.toLowerCase())
      if ((options.rejectCodes ?? []).includes(code) || account === undefined) {
        return Response.json({ error: 'bad_verification_code' }, { status: 200 })
      }
      byCode.set('gho_' + code, account)
      return Response.json({ access_token: 'gho_' + code, token_type: 'bearer', scope: 'read:user' }, { status: 200 })
    }
    if (call.method === 'GET' && url.pathname === '/user') {
      const authorization = call.headers.authorization ?? ''
      const account = byCode.get(authorization.replace(/^Bearer /i, ''))
      if (account === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 })
      return Response.json(account, { status: 200 })
    }
    if (call.method === 'GET' && url.pathname.startsWith('/users/')) {
      const login = decodeURIComponent(url.pathname.slice('/users/'.length)).toLowerCase()
      const account = byLogin.get(login)
      if (account === undefined) return Response.json({ message: 'Not Found' }, { status: 404 })
      return Response.json(account, { status: 200 })
    }
    return Response.json({ message: 'not found' }, { status: 404 })
  }
}

/** Contract-shaped fake of the APNs device endpoint. */
export function apnsHandler(options: { unregistered?: string[] } = {}): (call: RecordedCall) => Response {
  const unregistered = new Set(options.unregistered ?? [])
  return (call) => {
    const url = new URL(call.url)
    const deviceToken = url.pathname.split('/').pop() ?? ''
    if (!url.pathname.startsWith('/3/device/')) {
      return Response.json({ reason: 'BadPath' }, { status: 404 })
    }
    if (unregistered.has(deviceToken)) {
      return Response.json({ reason: 'Unregistered' }, { status: 410 })
    }
    return new Response(null, { status: 200 })
  }
}

export interface ExternalOptions {
  github: GithubFakeOptions
  apns?: { unregistered?: string[] }
}

/** One transport serving both external services, recording every request. */
export function externalTransport(options: ExternalOptions): RecordedTransport {
  const github = githubHandler(options.github)
  const apns = apnsHandler(options.apns ?? {})
  return recordingTransport((call) => {
    const host = new URL(call.url).host
    if (host === 'github.com' || host === 'api.github.com') return github(call)
    if (host === 'api.push.apple.com' || host === 'api.sandbox.push.apple.com') return apns(call)
    return Response.json({ message: 'unexpected outbound host ' + host }, { status: 404 })
  })
}

/** The Worker environment with an injected outbound transport. */
export function createEnv(transport: OutboundTransport): TestEnv {
  return { ...workerEnv, TEAM_HUB_OUTBOUND: transport }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export { worker, workerEnv }