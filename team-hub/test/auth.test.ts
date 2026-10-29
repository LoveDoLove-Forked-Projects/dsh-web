import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  createEnv,
  externalTransport,
  one,
  seedTeam,
  T0,
  type GithubAccount,
} from './helpers'
import { PROTOCOL_HEADER } from '../src/constants'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: 'https://img/octo.png' }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: 'https://img/hubot.png' }

function codeChallenge(): string {
  return 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
}

function state(): string {
  return 'c3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3RhdGU'
}

describe('oauth authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('user is redirected to GitHub for the ios client with the PKCE challenge', async () => {
    // Given a hub with no session
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)

    // When the iOS app starts the authorization code flow with PKCE
    const result = await api(env, 'GET', '/auth/github/authorize', {
      query: {
        client: 'ios',
        redirect_uri: 'whale://auth/callback',
        state: state(),
        code_challenge: codeChallenge(),
        code_challenge_method: 'S256',
      },
    })

    // Then GitHub is asked with the challenge and the hub callback
    expect(result.status).toBe(302)
    const location = new URL(result.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(location.searchParams.get('code_challenge')).toBe(codeChallenge())
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('redirect_uri')).toBe('https://hub.example/auth/github/callback')
    expect(location.searchParams.get('state')).toBe(state())
  })

  it('user is rejected when the ios client omits the PKCE challenge', async () => {
    // Given a hub with no session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)

    // When the iOS client asks for authorization without a challenge
    const result = await api(env, 'GET', '/auth/github/authorize', {
      query: { client: 'ios', redirect_uri: 'whale://auth/callback', state: state() },
    })

    // Then the request is refused as a validation failure
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('VALIDATION_FAILED')
    expect(result.body.error.details.field).toBe('code_challenge')
  })

  it('user is rejected when the authorize state is shorter than 32 bytes', async () => {
    // Given a hub with no session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)

    // When the client sends a short state
    const result = await api(env, 'GET', '/auth/github/authorize', {
      query: { client: 'web', redirect_uri: 'https://hub.example/app', state: 'c2hvcnQ' },
    })

    // Then the state is refused
    expect(result.status).toBe(400)
    expect(result.body.error.details.field).toBe('state')
  })

  it('user is rejected when the web redirect_uri leaves the hub origin', async () => {
    // Given a hub with no session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)

    // When a web client names a foreign origin
    const result = await api(env, 'GET', '/auth/github/authorize', {
      query: { client: 'web', redirect_uri: 'https://evil.example/app', state: state() },
    })

    // Then the redirect target is refused
    expect(result.status).toBe(400)
    expect(result.body.error.details.field).toBe('redirect_uri')
  })

  it('user is rejected when the client parameter is unknown', async () => {
    // Given a hub with no session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)

    // When the client value names neither web nor ios
    const result = await api(env, 'GET', '/auth/github/authorize', {
      query: { client: 'desktop', redirect_uri: 'whale://auth/callback', state: state() },
    })

    // Then the request is refused
    expect(result.status).toBe(400)
    expect(result.body.error.details.field).toBe('client')
  })
})

describe('oauth callback and token exchange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('user receives the authorization code on the app scheme after the ios callback', async () => {
    // Given an iOS authorization that is pending
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)
    await api(env, 'GET', '/auth/github/authorize', {
      query: {
        client: 'ios',
        redirect_uri: 'whale://auth/callback',
        state: state(),
        code_challenge: codeChallenge(),
        code_challenge_method: 'S256',
      },
    })

    // When GitHub redirects back to the hub callback
    const result = await api(env, 'GET', '/auth/github/callback', {
      query: { code: 'octocat', state: state() },
    })

    // Then the app scheme receives the code and the original state
    expect(result.status).toBe(302)
    const location = new URL(result.headers.get('location') as string)
    expect(location.protocol).toBe('whale:')
    expect(location.searchParams.get('code')).toBe('octocat')
    expect(location.searchParams.get('state')).toBe(state())
  })

  it('user receives a web session cookie after the web callback', async () => {
    // Given a web authorization for a member of a seeded team
    const team = await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)
    await api(env, 'GET', '/auth/github/authorize', {
      query: { client: 'web', redirect_uri: 'https://hub.example/app', state: state() },
    })

    // When GitHub redirects back with a valid code
    const result = await api(env, 'GET', '/auth/github/callback', {
      query: { code: 'octocat', state: state() },
    })

    // Then the member is redirected into the app with a session cookie
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('https://hub.example/app?state=' + state())
    const cookie = result.headers.get('set-cookie') as string
    expect(cookie).toContain('th_session=th_usr_')
    expect(cookie).toContain('HttpOnly')
    const member = await one<{ status: string }>(env, 'SELECT status FROM members WHERE github_username = ?', 'octocat')
    expect(member?.status).toBe('active')
    expect(team.teamId.startsWith('team_')).toBe(true)
  })

  it('user is rejected when the callback state is unknown', async () => {
    // Given a hub with no pending authorization
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)

    // When a callback arrives with an unknown state
    const result = await api(env, 'GET', '/auth/github/callback', {
      query: { code: 'octocat', state: state() },
    })

    // Then the code is refused
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('INVALID_OAUTH_CODE')
  })

  it('user receives a token pair and their membership from the PKCE token endpoint', async () => {
    // Given a seeded team and a GitHub account that belongs to it
    await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)

    // When the app exchanges the authorization code with its verifier
    const result = await api(env, 'POST', '/auth/token', {
      body: { code: 'hubot', code_verifier: 'verifier-value', redirect_uri: 'whale://auth/callback' },
    })

    // Then a dual token pair and the member come back
    expect(result.status).toBe(200)
    expect(result.body.token_type).toBe('Bearer')
    expect(result.body.expires_in).toBe(7200)
    expect(result.body.access_token).toMatch(/^th_usr_/)
    expect(result.body.refresh_token).toMatch(/^th_ref_/)
    expect(result.body.member.github_username).toBe('hubot')
  })

  it('user is told the PKCE exchange failed when GitHub rejects the verifier', async () => {
    // Given a seeded team and a GitHub that rejects the exchange
    await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(
      externalTransport({ github: { accounts: [OCTOCAT], rejectCodes: ['octocat'] } }).transport,
    )

    // When the app exchanges a code GitHub refuses
    const result = await api(env, 'POST', '/auth/token', {
      body: { code: 'octocat', code_verifier: 'wrong', redirect_uri: 'whale://auth/callback' },
    })

    // Then the PKCE failure is reported
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('INVALID_PKCE')
  })

  it('user is refused a session when their GitHub account is not on the team', async () => {
    // Given a team that does not include the authenticating account
    await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const stranger = { id: 4242, login: 'stranger', name: 'Str Anger', avatar_url: 'https://img/s.png' }
    const envWithStranger = createEnv(
      externalTransport({ github: { accounts: [OCTOCAT, HUBOT, stranger] } }).transport,
    )

    // When the stranger logs in
    const result = await api(envWithStranger, 'POST', '/auth/token', {
      body: { code: 'stranger', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })

    // Then the login is forbidden and no session was created
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('FORBIDDEN')
    const sessions = await one<{ n: number }>(envWithStranger, 'SELECT COUNT(*) AS n FROM refresh_tokens')
    expect(sessions?.n).toBe(0)
  })
})

describe('session lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('user keeps working with a rotated token pair after refresh', async () => {
    // Given a member with a session
    await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const issued = await api(env, 'POST', '/auth/token', {
      body: { code: 'hubot', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })
    const firstRefresh = issued.body.refresh_token as string

    // When the client refreshes the session
    const refreshed = await api(env, 'POST', '/auth/refresh', { body: { refresh_token: firstRefresh } })

    // Then a new pair is returned, the old refresh token is dead, and the new
    // access token is accepted by an authenticated endpoint
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.refresh_token).not.toBe(firstRefresh)
    expect(refreshed.body.member.github_username).toBe('hubot')
    const replay = await api(env, 'POST', '/auth/refresh', { body: { refresh_token: firstRefresh } })
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN')
    const me = await api(env, 'GET', '/api/v1/me', { token: refreshed.body.access_token as string })
    expect(me.status).toBe(200)
    expect(me.body.member.github_username).toBe('hubot')
  })

  it('user is signed out immediately when the session is revoked', async () => {
    // Given a member with a session
    await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const issued = await api(env, 'POST', '/auth/token', {
      body: { code: 'hubot', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })
    const accessToken = issued.body.access_token as string
    const refreshToken = issued.body.refresh_token as string

    // When the client revokes the refresh token
    const revoked = await api(env, 'POST', '/auth/revoke', { token: accessToken, body: { refresh_token: refreshToken } })

    // Then both tokens stop working
    expect(revoked.status).toBe(200)
    const me = await api(env, 'GET', '/api/v1/me', { token: accessToken })
    expect(me.status).toBe(401)
    expect(me.body.error.code).toBe('UNAUTHORIZED')
    const refresh = await api(env, 'POST', '/auth/refresh', { body: { refresh_token: refreshToken } })
    expect(refresh.status).toBe(401)
  })

  it('user is refused once the access token outlives its two hour life', async () => {
    // Given a member whose token was issued at the current instant
    const team = await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const issued = await api(env, 'POST', '/auth/token', {
      body: { code: 'hubot', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })
    expect(team.teamId).toBe(issued.body.member.team_id)

    // When two hours pass
    vi.setSystemTime(T0 + 7_200_001)

    // Then the bearer token is no longer accepted
    const me = await api(env, 'GET', '/api/v1/me', { token: issued.body.access_token as string })
    expect(me.status).toBe(401)
    expect(me.body.error.message).toContain('expired')
  })

  it('user sees every team they belong to from the identity endpoint', async () => {
    // Given a member of one team
    const team = await seedTeam(createEnv(externalTransport({ github: { accounts: [] } }).transport))
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const issued = await api(env, 'POST', '/auth/token', {
      body: { code: 'octocat', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })

    // When the client asks who it is
    const me = await api(env, 'GET', '/api/v1/me', { token: issued.body.access_token as string })

    // Then the membership and its role come back
    expect(me.status).toBe(200)
    expect(me.body.member.github_username).toBe('octocat')
    expect(me.body.teams).toEqual([{ team_id: team.teamId, role: 'admin' }])
  })
})

describe('protocol version gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('user is refused a request that omits the protocol version header', async () => {
    // Given a seeded team
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)
    const team = await seedTeam(env)

    // When a request arrives without the version header
    const result = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/members', {
      omitProtocol: true,
      token: 'irrelevant',
    })

    // Then the version negotiation refuses it
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION')
  })

  it('user is accepted when the client speaks a newer minor version', async () => {
    // Given a seeded team and an admin session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)
    const team = await seedTeam(env)
    const issued = await api(env, 'POST', '/auth/token', {
      body: { code: 'octocat', code_verifier: 'verifier', redirect_uri: 'whale://auth/callback' },
    })

    // When the client declares a compatible newer minor version
    const result = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/members', {
      token: issued.body.access_token as string,
      headers: { [PROTOCOL_HEADER]: '1.7.3' },
    })

    // Then the request is served
    expect(result.status).toBe(200)
    expect(result.body.members).toHaveLength(2)
  })

  it('user is refused when the client speaks another major version', async () => {
    // Given a seeded team and an admin session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT] } }).transport)
    const team = await seedTeam(env)

    // When the client declares a different major version
    const result = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/members', {
      token: 'th_at_invalid',
      headers: { [PROTOCOL_HEADER]: '2.0.0' },
    })

    // Then the version negotiation refuses it before authentication
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION')
  })
})