import {
  ACCESS_TOKEN_TTL_MS,
  HOST_TOKEN_HEX_LENGTH,
  HOST_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
} from '../constants'
import { HubError, fail } from '../errors'
import { newId, randomHex, sha256Hex } from '../ids'
import type { HostRow, MemberRow } from '../types'

const ACCESS_TOKEN_PREFIX = 'th_usr_'
const REFRESH_TOKEN_PREFIX = 'th_ref_'
/** Cookie the Web GUI carries its session in (PROTOCOL.md section 2). */
export const SESSION_COOKIE = 'th_session'
export const REFRESH_COOKIE = 'th_refresh'

export interface SessionTokens {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
}

export interface MemberPrincipal {
  kind: 'member'
  member: MemberRow
  sessionId: string
}

export interface HostPrincipal {
  kind: 'host'
  host: HostRow
}

export type Principal = MemberPrincipal | HostPrincipal

interface RefreshTokenRow {
  id: string
  member_id: string
  session_id: string
  token_hash: string
  expires_at: number
  created_at: number
  revoked_at: number | null
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromBase64url(value: string): Uint8Array {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Byte length of a base64url string once decoded, used to police state sizes. */
export function base64urlByteLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1
  try {
    return fromBase64url(value).length
  } catch {
    return -1
  }
}

function timingSafeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const secret = env.TEAM_HUB_SIGNING_SECRET
  if (!secret) fail('NOT_CONFIGURED', 'TEAM_HUB_SIGNING_SECRET is not configured on this hub.')
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

async function signAccessToken(env: Env, memberId: string, sessionId: string, now: number): Promise<string> {
  const expiresAt = now + ACCESS_TOKEN_TTL_MS
  const payload = toBase64url(new TextEncoder().encode(`${memberId}|${sessionId}|${expiresAt}`))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(payload))
  return `${ACCESS_TOKEN_PREFIX}${payload}.${toBase64url(new Uint8Array(signature))}`
}

/** Verify a session access token: signature first, then expiry. */
export async function verifyAccessToken(
  env: Env,
  token: string,
  now: number,
): Promise<{ memberId: string; sessionId: string } | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null
  const body = token.slice(ACCESS_TOKEN_PREFIX.length)
  const separator = body.indexOf('.')
  if (separator < 0) return null
  const payload = body.slice(0, separator)
  const signature = body.slice(separator + 1)
  const expected = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(payload))
  if (!timingSafeEquals(signature, toBase64url(new Uint8Array(expected)))) return null
  let decoded: string
  try {
    decoded = new TextDecoder().decode(fromBase64url(payload))
  } catch {
    return null
  }
  const [memberId, sessionId, expiresAt] = decoded.split('|')
  if (!memberId || !sessionId || !expiresAt) return null
  if (Number.parseInt(expiresAt, 10) <= now) return null
  return { memberId, sessionId }
}

/** Mint a Host Token; only the hash of the returned plaintext is ever stored. */
export function mintHostToken(): { token: string; tokenHash: Promise<string> } {
  const token = `${HOST_TOKEN_PREFIX}${randomHex(HOST_TOKEN_HEX_LENGTH / 2)}`
  return { token, tokenHash: sha256Hex(token) }
}

export async function hashHostToken(token: string): Promise<string> {
  return sha256Hex(token)
}

async function isSessionAlive(env: Env, sessionId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS alive FROM refresh_tokens WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
  )
    .bind(sessionId, now)
    .first<{ alive: number }>()
  return row !== null
}

/** Issue a fresh token pair and open a new session (section 2). */
export async function issueSession(
  env: Env,
  member: MemberRow,
  now: number,
): Promise<{ tokens: SessionTokens; sessionId: string }> {
  const sessionId = randomHex(16)
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomHex(32)}`
  await env.DB.prepare(
    `INSERT INTO refresh_tokens (id, member_id, session_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(newId('rtok', now), member.id, sessionId, await sha256Hex(refreshToken), now + REFRESH_TOKEN_TTL_MS, now)
    .run()
  const accessToken = await signAccessToken(env, member.id, sessionId, now)
  return {
    sessionId,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    },
  }
}

/**
 * Rotate a refresh token: the presented token is revoked and replaced inside
 * one D1 batch, so a replay of the old token can never win a second session.
 */
export async function rotateRefreshToken(
  env: Env,
  presented: string,
  now: number,
): Promise<{ tokens: SessionTokens; member: MemberRow }> {
  const row = await env.DB.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(presented))
    .first<RefreshTokenRow>()
  if (!row || row.revoked_at !== null || row.expires_at <= now) {
    fail('INVALID_REFRESH_TOKEN', 'Refresh token is unknown, revoked, or expired.')
  }
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(row.member_id).first<MemberRow>()
  if (!member || member.status !== 'active') {
    fail('INVALID_REFRESH_TOKEN', 'The member behind this refresh token is not active.')
  }
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomHex(32)}`
  const accessToken = await signAccessToken(env, member.id, row.session_id, now)
  await env.DB.batch([
    env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').bind(now, row.id),
    env.DB.prepare(
      `INSERT INTO refresh_tokens (id, member_id, session_id, token_hash, expires_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(newId('rtok', now), member.id, row.session_id, await sha256Hex(refreshToken), now + REFRESH_TOKEN_TTL_MS, now),
  ])
  return {
    member,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    },
  }
}

/** Revoke the presented refresh token and terminate its whole session. */
export async function revokeSession(env: Env, presented: string, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(presented))
    .first<RefreshTokenRow>()
  if (!row) fail('UNAUTHORIZED', 'Refresh token is unknown.')
  await env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
    .bind(now, row.session_id)
    .run()
}

/** Terminate every session of a member, used when a member is removed. */
export async function revokeMemberSessions(env: Env, memberId: string, now: number): Promise<void> {
  await env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL')
    .bind(now, memberId)
    .run()
}

/** One cookie of the request, or null when it is not present. */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name && rest.length > 0) return rest.join('=')
  }
  return null
}

function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header && header.toLowerCase().startsWith('bearer ')) {
    const value = header.slice(7).trim()
    if (value !== '') return value
  }
  return cookieValue(request, SESSION_COOKIE)
}

/**
 * Resolve the caller of a request into a member or a host principal. Team
 * membership itself is checked by the router, which knows the team from the
 * path; this function only establishes identity.
 */
export async function authenticate(env: Env, request: Request, now: number): Promise<Principal> {
  const token = bearerFromRequest(request)
  if (token === null) fail('UNAUTHORIZED', 'Missing bearer token.')
  if (token.startsWith(HOST_TOKEN_PREFIX)) {
    const host = await env.DB.prepare('SELECT * FROM hosts WHERE token_hash = ?')
      .bind(await hashHostToken(token))
      .first<HostRow>()
    if (!host) fail('UNAUTHORIZED', 'Host token is not recognised.')
    if (host.status === 'revoked') fail('UNAUTHORIZED', 'Host token has been revoked.')
    return { kind: 'host', host }
  }
  const claims = await verifyAccessToken(env, token, now)
  if (!claims) fail('UNAUTHORIZED', 'Access token is invalid or expired.')
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(claims.memberId).first<MemberRow>()
  if (!member) fail('UNAUTHORIZED', 'The member behind this token no longer exists.')
  if (member.status !== 'active') fail('UNAUTHORIZED', 'The member behind this token is not active.')
  if (!(await isSessionAlive(env, claims.sessionId, now))) {
    fail('UNAUTHORIZED', 'This session has been revoked.')
  }
  return { kind: 'member', member, sessionId: claims.sessionId }
}

export function requireMember(principal: Principal): MemberPrincipal {
  if (principal.kind !== 'member') fail('FORBIDDEN', 'This endpoint requires a member session token.')
  return principal
}

export function requireAdmin(principal: Principal): MemberPrincipal {
  const member = requireMember(principal)
  if (member.member.role !== 'admin') fail('FORBIDDEN', 'This endpoint requires the admin role.')
  return member
}

export function requireHost(principal: Principal): HostPrincipal {
  if (principal.kind !== 'host') fail('FORBIDDEN', 'This endpoint requires a Host token.')
  return principal
}

/** Re-exported so callers do not need to import the error class directly. */
export { HubError }