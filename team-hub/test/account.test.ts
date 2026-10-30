import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_AUDIENCE,
  ACCOUNT_ISSUER,
  ACCOUNT_JWKS_URL,
  accountAssertion,
  accountJwks,
  accountKey,
  api,
  createEnv,
  externalTransport,
  iosLogin,
  one,
  seedTeam,
  T0,
  tokenFor,
  type AccountKey,
  type GithubAccount,
  type MemberRow,
} from './helpers'
import type { OutboundTransport } from '../src/outbound'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }
const ACCOUNT_SUB = 'acct_hubot'

/** A fake account service publishing the given key's JWKS next to the GitHub fake. */
function accountTransport(key: AccountKey) {
  return externalTransport({ github: { accounts: [OCTOCAT, HUBOT] }, account: { jwks: accountJwks(key) } })
}

function accountEnv(key: AccountKey, transport: OutboundTransport) {
  return { ...createEnv(transport), ACCOUNT_JWKS_URL, ACCOUNT_ISSUER, ACCOUNT_AUDIENCE }
}

function accountSignIn(env: Env, assertion: string) {
  return api(env, 'POST', '/auth/account', { body: { assertion } })
}

/** Bind the account from an existing hub session, exactly as the client does. */
async function bindAccount(env: Env, member: MemberRow, key: AccountKey, sub = ACCOUNT_SUB): Promise<void> {
  const linked = await api(env, 'POST', '/auth/account/link', {
    token: await tokenFor(env, member),
    body: { assertion: await accountAssertion(key, { sub }) },
  })
  if (linked.status !== 200) throw new Error('link fixture failed: ' + linked.text)
}

describe('POST /auth/account', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member signs in with the account assertion once the account is linked', async () => {
    // Given a member who entered through GitHub during the transition and bound
    // their account service identity from that session
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    const login = await iosLogin(env, 'hubot')
    expect(login.status).toBe(200)
    const linked = await api(env, 'POST', '/auth/account/link', {
      token: login.body.access_token as string,
      body: { assertion: await accountAssertion(key, { sub: ACCOUNT_SUB }) },
    })
    expect(linked.status).toBe(200)
    expect(linked.body.member.id).toBe(team.member.id)

    // When the account service assertion is presented a minute later
    vi.setSystemTime(T0 + 60_000)
    const signed = await accountSignIn(env, await accountAssertion(key, { sub: ACCOUNT_SUB, now: T0 + 60_000 }))

    // Then a hub session comes back, in the same pair the GitHub flow issues
    expect(signed.status).toBe(200)
    expect(signed.body.token_type).toBe('Bearer')
    expect(signed.body.expires_in).toBe(7200)
    expect(signed.body.access_token).toMatch(/^th_usr_/)
    expect(signed.body.refresh_token).toMatch(/^th_ref_/)
    expect(signed.body.member.id).toBe(team.member.id)
    expect(signed.body.member.github_username).toBe('hubot')

    // And that session works, with the member's last_seen touched
    const me = await api(env, 'GET', '/api/v1/me', { token: signed.body.access_token as string })
    expect(me.status).toBe(200)
    expect(me.body.member.id).toBe(team.member.id)
    const row = await one<{ updated_at: number }>(env, 'SELECT updated_at FROM members WHERE id = ?', team.member.id)
    expect(row?.updated_at).toBe(T0 + 60_000)
  })

  it('account sign-in is refused while no member is bound to the account', async () => {
    // Given a hub where nobody has bound this account
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    await seedTeam(env)
    const before = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM members')

    // When a perfectly valid assertion arrives
    const result = await accountSignIn(env, await accountAssertion(key, { sub: ACCOUNT_SUB }))

    // Then it is refused with a code the client can turn into a link prompt, and
    // holding a valid credential created nothing
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('NOT_LINKED')
    const after = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM members')
    expect(after?.n).toBe(before?.n)
    const bound = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM members WHERE account_user_id IS NOT NULL')
    expect(bound?.n).toBe(0)
    const sessions = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM refresh_tokens')
    expect(sessions?.n).toBe(0)
  })

  it('assertion signed by another key is refused', async () => {
    // Given a hub whose account service publishes one key, and a member already bound
    const published = await accountKey()
    const impostor = await accountKey()
    const env = accountEnv(published, accountTransport(published).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, published)

    // When an assertion signed by a different key claims the published key id
    const assertion = await accountAssertion(impostor, { kid: published.kid, sub: ACCOUNT_SUB })
    const result = await accountSignIn(env, assertion)

    // Then the signature check refuses it
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('signature')
  })

  it('assertion addressed to another audience is refused', async () => {
    // Given a bound member and a hub that accepts dsh-team-hub only
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, key)

    // When the assertion names another service as its audience
    const result = await accountSignIn(env, await accountAssertion(key, { aud: 'another-service' }))

    // Then it is refused
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('audience')
  })

  it('assertion from another issuer is refused', async () => {
    // Given a bound member and a hub that trusts one account service origin
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, key)

    // When the assertion claims another issuer
    const result = await accountSignIn(
      env,
      await accountAssertion(key, { iss: 'https://account.example.evil' }),
    )

    // Then it is refused, and the answer names the issuer it would not trust
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.details.issuer).toBe('https://account.example.evil')
  })

  it('expired assertion is refused', async () => {
    // Given a bound member
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, key)

    // When the assertion was issued an hour ago and lived for a minute
    const expired = await accountAssertion(key, { now: T0 - 3_600_000, ttl: 60 })
    const result = await accountSignIn(env, expired)

    // Then its exp is in the past and the hub refuses it
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('expired')
  })

  it('assertion naming an unknown key id is refused', async () => {
    // Given a bound member
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, key)

    // When the header names a kid the account service never published
    const result = await accountSignIn(env, await accountAssertion(key, { kid: 'account-key-not-published' }))

    // Then the hub finds no key to verify with and refuses
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('key id')
  })

  it('account sign-in is closed until the account service settings are stored', async () => {
    // Given a hub without ACCOUNT_JWKS_URL, ACCOUNT_ISSUER and ACCOUNT_AUDIENCE
    const key = await accountKey()
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)

    // When both account endpoints are called
    const signIn = await accountSignIn(env, await accountAssertion(key))
    const link = await api(env, 'POST', '/auth/account/link', {
      token: adminToken,
      body: { assertion: await accountAssertion(key) },
    })

    // Then both answer NOT_CONFIGURED instead of guessing at trust
    expect(signIn.status).toBe(503)
    expect(signIn.body.error.code).toBe('NOT_CONFIGURED')
    expect(link.status).toBe(503)
    expect(link.body.error.code).toBe('NOT_CONFIGURED')
  })
})

describe('POST /auth/account/link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('link binds the account to the member whose hub session carried it', async () => {
    // Given a member with a hub session and a valid assertion for their account
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When that session binds the account
    const linked = await api(env, 'POST', '/auth/account/link', {
      token,
      body: { assertion: await accountAssertion(key, { sub: ACCOUNT_SUB }) },
    })

    // Then the member carries the account user id
    expect(linked.status).toBe(200)
    expect(linked.body.member.id).toBe(team.member.id)
    const row = await one<{ account_user_id: string | null }>(
      env,
      'SELECT account_user_id FROM members WHERE id = ?',
      team.member.id,
    )
    expect(row?.account_user_id).toBe(ACCOUNT_SUB)
  })

  it('link is refused when another member already holds the account', async () => {
    // Given an account already bound to the admin
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.admin, key)

    // When another member tries to bind the same account
    const linked = await api(env, 'POST', '/auth/account/link', {
      token: await tokenFor(env, team.member),
      body: { assertion: await accountAssertion(key, { sub: ACCOUNT_SUB }) },
    })

    // Then the identity belongs to one member only
    expect(linked.status).toBe(409)
    expect(linked.body.error.code).toBe('IDENTITY_TAKEN')
    const row = await one<{ account_user_id: string | null }>(
      env,
      'SELECT account_user_id FROM members WHERE id = ?',
      team.member.id,
    )
    expect(row?.account_user_id).toBeNull()
  })

  it('link is idempotent for the same account', async () => {
    // Given a member that already bound their account
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    const team = await seedTeam(env)
    await bindAccount(env, team.member, key)

    // When the same binding is presented again from the same session
    const again = await api(env, 'POST', '/auth/account/link', {
      token: await tokenFor(env, team.member),
      body: { assertion: await accountAssertion(key, { sub: ACCOUNT_SUB }) },
    })

    // Then it succeeds and the account is still bound exactly once
    expect(again.status).toBe(200)
    expect(again.body.member.id).toBe(team.member.id)
    const bound = await one<{ n: number }>(
      env,
      'SELECT COUNT(*) AS n FROM members WHERE account_user_id = ?',
      ACCOUNT_SUB,
    )
    expect(bound?.n).toBe(1)
  })

  it('link requires a hub session', async () => {
    // Given a hub with an account service configured
    const key = await accountKey()
    const env = accountEnv(key, accountTransport(key).transport)
    await seedTeam(env)

    // When the binding is attempted without a session
    const linked = await api(env, 'POST', '/auth/account/link', {
      body: { assertion: await accountAssertion(key) },
    })

    // Then the hub asks for one first
    expect(linked.status).toBe(401)
    expect(linked.body.error.code).toBe('UNAUTHORIZED')
  })

  it('github login keeps working while the account service is not configured', async () => {
    // Given a hub with no account service settings at all
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    await seedTeam(env)

    // When a member signs in through the transition entry point
    const login = await iosLogin(env, 'hubot')

    // Then the GitHub flow answers exactly as before
    expect(login.status).toBe(200)
    expect(login.body.token_type).toBe('Bearer')
    expect(login.body.member.github_username).toBe('hubot')
  })
})
