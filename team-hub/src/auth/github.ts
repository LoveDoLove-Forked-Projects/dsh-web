import { OAUTH_STATE_TTL_MS } from '../constants'
import { fail } from '../errors'
import {
  GITHUB_API_BASE,
  GITHUB_CALLBACK_PATH,
  GITHUB_OAUTH_BASE,
  IOS_REDIRECT_URI,
  transportOf,
} from '../outbound'
import type { MemberRow } from '../types'
import { base64urlByteLength, issueSession, type SessionTokens } from './session'

export interface AuthorizeRequest {
  client: 'web' | 'ios'
  redirectUri: string
  state: string
  codeChallenge: string | null
  codeChallengeMethod: string | null
}

interface OauthStateRow {
  state: string
  client: 'web' | 'ios'
  redirect_uri: string
  code_challenge: string | null
  code_challenge_method: string | null
  created_at: number
  expires_at: number
}

interface GithubUser {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

interface GithubTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

function requireBase64url(value: string, minimumBytes: number, field: string): void {
  const bytes = base64urlByteLength(value)
  if (bytes < minimumBytes) {
    fail('VALIDATION_FAILED', field + ' must be base64url encoding at least ' + minimumBytes + ' bytes.', { field })
  }
}

/**
 * Supplement A1.6: validate the authorize query before anything is stored.
 * The client owns the state value, the redirect target and, on iOS, the PKCE
 * challenge; the Hub only accepts the shapes the specification allows.
 */
export function parseAuthorizeRequest(url: URL): AuthorizeRequest {
  const client = url.searchParams.get('client')
  if (client !== 'web' && client !== 'ios') {
    fail('VALIDATION_FAILED', "client is required and must be 'web' or 'ios'.", { field: 'client' })
  }
  const state = url.searchParams.get('state')
  if (state === null) fail('VALIDATION_FAILED', 'state is required.', { field: 'state' })
  requireBase64url(state, 32, 'state')

  const redirectUri = url.searchParams.get('redirect_uri')
  if (redirectUri === null || redirectUri === '') {
    fail('VALIDATION_FAILED', 'redirect_uri is required.', { field: 'redirect_uri' })
  }
  if (client === 'ios') {
    if (redirectUri !== IOS_REDIRECT_URI) {
      fail('VALIDATION_FAILED', 'redirect_uri for the ios client must be exactly ' + IOS_REDIRECT_URI + '.', {
        field: 'redirect_uri',
      })
    }
  } else {
    let parsed: URL
    try {
      parsed = new URL(redirectUri)
    } catch {
      fail('VALIDATION_FAILED', 'redirect_uri must be an absolute URL.', { field: 'redirect_uri' })
    }
    if (parsed.origin !== url.origin) {
      fail('VALIDATION_FAILED', 'redirect_uri for the web client must share this hub origin.', {
        field: 'redirect_uri',
      })
    }
  }

  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method')
  if (client === 'ios') {
    if (codeChallenge === null) {
      fail('VALIDATION_FAILED', 'code_challenge is required for the ios client.', { field: 'code_challenge' })
    }
    if (codeChallengeMethod !== 'S256') {
      fail('VALIDATION_FAILED', "code_challenge_method must be 'S256'.", { field: 'code_challenge_method' })
    }
    requireBase64url(codeChallenge, 32, 'code_challenge')
  } else if (codeChallenge !== null) {
    if (codeChallengeMethod !== 'S256') {
      fail('VALIDATION_FAILED', "code_challenge_method must be 'S256' when a challenge is supplied.", {
        field: 'code_challenge_method',
      })
    }
    requireBase64url(codeChallenge, 32, 'code_challenge')
  }

  return {
    client,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod: codeChallenge === null ? null : 'S256',
  }
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } })
}

/** Serialise one session cookie; the Web GUI never reads these from JavaScript. */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return name + '=' + value + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAgeSeconds
}

async function githubJson(env: Env, url: string, init: RequestInit): Promise<unknown> {
  const response = await transportOf(env)(url, init)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Exchange a GitHub authorization code, forwarding the PKCE verifier if given. */
async function exchangeCodeForGithubToken(
  env: Env,
  code: string,
  codeVerifier: string | null,
  redirectUri: string,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  })
  if (codeVerifier !== null) form.set('code_verifier', codeVerifier)
  const body = (await githubJson(env, GITHUB_OAUTH_BASE + '/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })) as GithubTokenResponse | null
  if (body === null || typeof body.access_token !== 'string' || body.access_token === '') {
    const reason = body?.error ?? 'unknown_error'
    if (codeVerifier !== null) {
      fail('INVALID_PKCE', 'GitHub rejected the code exchange (' + reason + ').', { github_error: reason })
    }
    fail('INVALID_OAUTH_CODE', 'GitHub rejected the authorization code (' + reason + ').', { github_error: reason })
  }
  return body.access_token
}

async function fetchGithubUser(env: Env, accessToken: string): Promise<GithubUser> {
  const user = (await githubJson(env, GITHUB_API_BASE + '/user', {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + accessToken,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-team-hub',
    },
  })) as Partial<GithubUser> | null
  if (user === null || typeof user.id !== 'number' || typeof user.login !== 'string') {
    fail('INVALID_OAUTH_CODE', 'GitHub did not return a usable user profile.')
  }
  return {
    id: user.id,
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
    avatar_url: typeof user.avatar_url === 'string' ? user.avatar_url : null,
  }
}

/**
 * Section 2 step 2: the first successful login of an invited member activates
 * the membership and binds the numeric GitHub user id.
 */
async function resolveMemberForGithubUser(env: Env, user: GithubUser, now: number): Promise<MemberRow> {
  const existing = await env.DB.prepare('SELECT * FROM members WHERE github_user_id = ? ORDER BY created_at LIMIT 1')
    .bind(user.id)
    .first<MemberRow>()
  if (existing) {
    if (existing.status === 'suspended') fail('FORBIDDEN', 'This membership is suspended.')
    if (existing.status === 'invited') {
      const displayName = user.name ?? existing.display_name
      const avatarUrl = user.avatar_url ?? existing.avatar_url
      await env.DB.prepare(
        "UPDATE members SET status = 'active', display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
      )
        .bind(displayName, avatarUrl, now, existing.id)
        .run()
      return { ...existing, status: 'active', display_name: displayName, avatar_url: avatarUrl, updated_at: now }
    }
    return existing
  }
  const byUsername = await env.DB.prepare(
    'SELECT * FROM members WHERE github_username = ? COLLATE NOCASE ORDER BY created_at LIMIT 1',
  )
    .bind(user.login)
    .first<MemberRow>()
  if (!byUsername) fail('FORBIDDEN', 'This GitHub account is not a member of any team on this hub.')
  if (byUsername.status === 'suspended') fail('FORBIDDEN', 'This membership is suspended.')
  const displayName = user.name ?? byUsername.display_name
  const avatarUrl = user.avatar_url ?? byUsername.avatar_url
  await env.DB.prepare(
    "UPDATE members SET status = 'active', github_user_id = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
  )
    .bind(user.id, displayName, avatarUrl, now, byUsername.id)
    .run()
  return {
    ...byUsername,
    status: 'active',
    github_user_id: user.id,
    display_name: displayName,
    avatar_url: avatarUrl,
    updated_at: now,
  }
}

/** GET /auth/github/authorize: remember the pending authorization and redirect. */
export async function beginAuthorize(env: Env, request: Request, now: number): Promise<Response> {
  const url = new URL(request.url)
  const params = parseAuthorizeRequest(url)
  try {
    await env.DB.prepare(
      'INSERT INTO oauth_states (state, client, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        params.state,
        params.client,
        params.redirectUri,
        params.codeChallenge,
        params.codeChallengeMethod,
        now,
        now + OAUTH_STATE_TTL_MS,
      )
      .run()
  } catch {
    fail('CONFLICT', 'This state value already has a pending authorization.', { field: 'state' })
  }
  const callback = url.origin + GITHUB_CALLBACK_PATH
  const target = new URL('/login/oauth/authorize', GITHUB_OAUTH_BASE)
  target.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  target.searchParams.set('redirect_uri', callback)
  target.searchParams.set('scope', 'read:user')
  target.searchParams.set('state', params.state)
  if (params.codeChallenge !== null) {
    target.searchParams.set('code_challenge', params.codeChallenge)
    target.searchParams.set('code_challenge_method', 'S256')
  }
  return redirect(target.toString())
}

/**
 * Exchange an authorization code for a Hub session. Used by the Web callback
 * and by POST /auth/token, which is how the iOS app finishes the PKCE flow.
 */
export async function completeAuthorizationCode(
  env: Env,
  options: { code: string; codeVerifier: string | null; redirectUri: string; now: number },
): Promise<{ member: MemberRow; tokens: SessionTokens }> {
  const githubToken = await exchangeCodeForGithubToken(env, options.code, options.codeVerifier, options.redirectUri)
  const user = await fetchGithubUser(env, githubToken)
  const member = await resolveMemberForGithubUser(env, user, options.now)
  const session = await issueSession(env, member, options.now)
  return { member, tokens: session.tokens }
}

/** GET /auth/github/callback: finish the Web login or hand the code to the app. */
export async function handleCallback(env: Env, request: Request, now: number): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code === null || code === '') fail('INVALID_OAUTH_CODE', 'The callback carries no authorization code.')
  if (state === null || state === '') fail('INVALID_OAUTH_CODE', 'The callback carries no state.')
  const row = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first<OauthStateRow>()
  if (!row || row.expires_at <= now) fail('INVALID_OAUTH_CODE', 'The authorization state is unknown or expired.')
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run()

  if (row.client === 'ios') {
    const target = new URL(row.redirect_uri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state)
    return redirect(target.toString())
  }

  const session = await completeAuthorizationCode(env, {
    code,
    codeVerifier: null,
    redirectUri: url.origin + GITHUB_CALLBACK_PATH,
    now,
  })
  const target = new URL(row.redirect_uri)
  target.searchParams.set('state', state)
  return redirect(target.toString(), {
    'set-cookie': sessionCookie('th_session', session.tokens.access_token, session.tokens.expires_in),
  })
}
