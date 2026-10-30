import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_SUB,
  accountAssertion,
  accountJwks,
  accountKey,
  api,
  bindAccount,
  inviteAndLogin,
  one,
  seedTeam,
  startTestHub,
  type AccountKey,
  type Session,
  type TestHub,
} from './helpers'

/**
 * Account-service sign-in against the real service. Every assertion is signed
 * with a real P-256 key and verified through the JWKS the fake account service
 * publishes over the same outbound seam the Worker suite uses.
 */

let active: TestHub | null = null

afterEach(async () => {
  if (active !== null) await active.close()
  active = null
})

interface AccountFixture {
  hub: TestHub
  key: AccountKey
  teamId: string
  admin: Session
}

async function boundFixture(): Promise<AccountFixture> {
  const key = await accountKey()
  const hub = await startTestHub({ jwks: accountJwks(key) })
  active = hub
  const team = await seedTeam(hub)
  await bindAccount(hub, team.admin.accessToken, key)
  return { hub, key, teamId: team.teamId, admin: team.admin }
}

function signIn(hub: TestHub, assertion: string) {
  return api(hub, 'POST', '/auth/account', { body: { assertion } })
}

async function sessionCount(hub: TestHub): Promise<number> {
  return one<{ n: number }>(hub, 'SELECT COUNT(*) AS n FROM refresh_tokens')?.n ?? -1
}

describe('account assertion verification', () => {
  it('a signature from another key is refused', async () => {
    // Given a hub whose account service publishes one key
    const fixture = await boundFixture()
    const impostor = await accountKey()

    // When an assertion signed by another key claims the published key id
    const result = await signIn(
      fixture.hub,
      await accountAssertion(impostor, { kid: fixture.key.kid, sub: ACCOUNT_SUB }),
    )

    // Then the signature check refuses it and opens no session
    const before = await sessionCount(fixture.hub)
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('signature')
    expect(await sessionCount(fixture.hub)).toBe(before)
  })

  it('an assertion for another audience is refused', async () => {
    const fixture = await boundFixture()

    const result = await signIn(fixture.hub, await accountAssertion(fixture.key, { aud: 'another-service' }))

    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('audience')
  })

  it('an assertion from another issuer is refused', async () => {
    const fixture = await boundFixture()

    const result = await signIn(
      fixture.hub,
      await accountAssertion(fixture.key, { iss: 'https://account.example.evil' }),
    )

    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.details.issuer).toBe('https://account.example.evil')
  })

  it('an expired assertion is refused', async () => {
    const fixture = await boundFixture()

    // Issued an hour ago with a one-minute lifetime
    const expired = await accountAssertion(fixture.key, { now: Date.now() - 3_600_000, ttl: 60 })
    const result = await signIn(fixture.hub, expired)

    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('expired')
  })

  it('an assertion naming an unpublished key id is refused', async () => {
    const fixture = await boundFixture()

    const result = await signIn(fixture.hub, await accountAssertion(fixture.key, { kid: 'account-key-not-published' }))

    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
    expect(result.body.error.message).toContain('key id')
  })
})

describe('account sign-in and linking', () => {
  it('a verified assertion opens a session for the bound member', async () => {
    // Given a member whose account was bound from a hub session
    const fixture = await boundFixture()
    const before = await sessionCount(fixture.hub)

    // When the account service assertion is presented
    const signed = await signIn(fixture.hub, await accountAssertion(fixture.key, { sub: ACCOUNT_SUB }))

    // Then a hub session comes back in the same token pair the GitHub flow issues
    expect(signed.status).toBe(200)
    expect(signed.body.token_type).toBe('Bearer')
    expect(signed.body.expires_in).toBe(7200)
    expect(signed.body.access_token).toMatch(/^th_usr_/)
    expect(signed.body.refresh_token).toMatch(/^th_ref_/)
    expect(signed.body.member.id).toBe(fixture.admin.member.id)
    expect(await sessionCount(fixture.hub)).toBe(before + 1)

    // And that session works against the member API
    const me = await api(fixture.hub, 'GET', '/api/v1/me', { token: signed.body.access_token as string })
    expect(me.status).toBe(200)
    expect(me.body.member.id).toBe(fixture.admin.member.id)
  })

  it('a verified assertion never creates a member', async () => {
    // Given a hub where nobody bound this account
    const key = await accountKey()
    const hub = await startTestHub({ jwks: accountJwks(key) })
    active = hub
    await seedTeam(hub)
    const membersBefore = one<{ n: number }>(hub, 'SELECT COUNT(*) AS n FROM members')?.n
    const before = await sessionCount(hub)

    // When a perfectly valid assertion arrives
    const result = await signIn(hub, await accountAssertion(key, { sub: 'acct_nobody' }))

    // Then it is refused with the code the client turns into a link prompt
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('NOT_LINKED')
    expect(result.body.error.details.sub).toBe('acct_nobody')
    expect(one<{ n: number }>(hub, 'SELECT COUNT(*) AS n FROM members')?.n).toBe(membersBefore)
    expect(await sessionCount(hub)).toBe(before)
    expect(one<{ n: number }>(hub, 'SELECT COUNT(*) AS n FROM members WHERE account_user_id IS NOT NULL')?.n).toBe(0)
  })

  it('one account belongs to one member and rebinding it is a no-op', async () => {
    // Given the admin already holds the account and a second member signed in
    const fixture = await boundFixture()
    const member: Session = await inviteAndLogin(
      fixture.hub,
      fixture.teamId,
      fixture.admin.accessToken,
      'hubot',
    )

    // When that other member presents the same binding
    const taken = await api(fixture.hub, 'POST', '/auth/account/link', {
      token: member.accessToken,
      body: { assertion: await accountAssertion(fixture.key, { sub: ACCOUNT_SUB }) },
    })

    // Then the identity stays with one member
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('IDENTITY_TAKEN')
    expect(one<{ account_user_id: string | null }>(
      fixture.hub,
      'SELECT account_user_id FROM members WHERE id = ?',
      member.member.id,
    )?.account_user_id).toBeNull()

    // And repeating the same binding from the member that holds it succeeds
    const again = await api(fixture.hub, 'POST', '/auth/account/link', {
      token: fixture.admin.accessToken,
      body: { assertion: await accountAssertion(fixture.key, { sub: ACCOUNT_SUB }) },
    })
    expect(again.status).toBe(200)
    expect(again.body.member.id).toBe(fixture.admin.member.id)
    expect(
      one<{ n: number }>(fixture.hub, 'SELECT COUNT(*) AS n FROM members WHERE account_user_id = ?', ACCOUNT_SUB)?.n,
    ).toBe(1)
  })

  it('account sign-in is closed until the account service settings are stored', async () => {
    // Given a hub with no ACCOUNT_* settings
    const hub = await startTestHub({
      env: { ACCOUNT_JWKS_URL: undefined, ACCOUNT_ISSUER: undefined, ACCOUNT_AUDIENCE: undefined },
    })
    active = hub
    const team = await seedTeam(hub)
    const key = await accountKey()

    // When both account endpoints are called
    const signInResult = await signIn(hub, await accountAssertion(key))
    const link = await api(hub, 'POST', '/auth/account/link', {
      token: team.admin.accessToken,
      body: { assertion: await accountAssertion(key) },
    })

    // Then both answer NOT_CONFIGURED instead of guessing at trust
    expect(signInResult.status).toBe(503)
    expect(signInResult.body.error.code).toBe('NOT_CONFIGURED')
    expect(link.status).toBe(503)
    expect(link.body.error.code).toBe('NOT_CONFIGURED')
  })
})
