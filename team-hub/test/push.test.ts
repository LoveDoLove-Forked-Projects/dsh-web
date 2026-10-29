import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env as workerEnv } from 'cloudflare:workers'
import { all, api, createEnv, externalTransport, one, seedTeam, T0, tokenFor, type GithubAccount } from './helpers'
import { resetProviderTokenCache } from '../src/push/apns'
import { APNS_JWT_TTL_MS } from '../src/constants'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

function decodeBase64url(value: string): Uint8Array {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJson(value: string): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(decodeBase64url(value)))
}

async function verifyProviderToken(jwt: string): Promise<boolean> {
  const [header, claims, signature] = jwt.split('.')
  if (header === undefined || claims === undefined || signature === undefined) return false
  const jwk = JSON.parse(workerEnv.TEST_APNS_PUBLIC_JWK) as JsonWebKey
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    decodeBase64url(signature),
    new TextEncoder().encode(header + '.' + claims),
  )
}

describe('push token registration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetProviderTokenCache()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member registers a device token that is stored once', async () => {
    // Given a member session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the app registers its device twice, the second time for production
    await api(env, 'POST', '/api/v1/push-tokens', {
      token,
      body: { platform: 'ios', device_token: 'device-1', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })
    const again = await api(env, 'POST', '/api/v1/push-tokens', {
      token,
      body: { platform: 'ios', device_token: 'device-1', bundle_id: 'com.example.whale', environment: 'production' },
    })

    // Then one row remains and it carries the latest environment
    expect(again.status).toBe(200)
    const stored = await all<{ environment: string; platform: string }>(
      env,
      'SELECT environment, platform FROM push_tokens WHERE member_id = ?',
      team.member.id,
    )
    expect(stored).toEqual([{ environment: 'production', platform: 'ios' }])
  })

  it('member is refused a device token with an unknown platform', async () => {
    // Given a member session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the registration names an unsupported platform
    const result = await api(env, 'POST', '/api/v1/push-tokens', {
      token,
      body: { platform: 'android', device_token: 'device-1', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })

    // Then the request is refused
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('member deletes a device token on logout', async () => {
    // Given a registered device
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)
    await api(env, 'POST', '/api/v1/push-tokens', {
      token,
      body: { platform: 'ios', device_token: 'device-1', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })

    // When the member unregisters it
    const removed = await api(env, 'DELETE', '/api/v1/push-tokens/device-1', { token })

    // Then the row is gone
    expect(removed.status).toBe(200)
    const stored = await one<{ id: string }>(env, 'SELECT id FROM push_tokens WHERE device_token = ?', 'device-1')
    expect(stored).toBeNull()
  })
})

describe('apns delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetProviderTokenCache()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('assigned notification carries a verifiable ES256 token and the section 10 payload', async () => {
    // Given a member with a registered production device
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    await api(env, 'POST', '/api/v1/push-tokens', {
      token: adminToken,
      body: { platform: 'ios', device_token: 'device-admin', bundle_id: 'com.example.whale', environment: 'production' },
    })

    // When an issue is assigned to that member
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member),
      body: { title: 'Ship it', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then APNs received one request with a valid provider token and payload
    const pushes = outbound.calls.filter((call) => call.url.includes('/3/device/'))
    expect(pushes).toHaveLength(1)
    const push = pushes[0]
    expect(push?.url).toBe('https://api.push.apple.com/3/device/device-admin')
    expect(push?.headers['apns-topic']).toBe('com.example.whale')
    expect(push?.headers['apns-push-type']).toBe('alert')
    const jwt = (push?.headers.authorization ?? '').replace(/^bearer /, '')
    expect(await verifyProviderToken(jwt)).toBe(true)
    const header = decodeJson(jwt.split('.')[0] as string)
    const claims = decodeJson(jwt.split('.')[1] as string)
    expect(header).toEqual({ alg: 'ES256', kid: 'ABC1234567', typ: 'JWT' })
    expect(claims.iss).toBe('TEAM123456')
    const body = JSON.parse(push?.body ?? '{}')
    expect(body.aps.alert).toEqual({ title: 'Team Collaboration', body: 'You were assigned to issue #1: Ship it' })
    expect(body.aps.category).toBe('TEAM_COLLAB')
    expect(body.aps.sound).toBe('default')
    expect(body.aps.badge).toBe(1)
    expect(body.team_id).toBe(team.teamId)
    expect(body.event_type).toBe('assigned')
  })

  it('provider token is reused inside its fifty minute cache window', async () => {
    // Given a member with a device and one delivered notification
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    await api(env, 'POST', '/api/v1/push-tokens', {
      token: adminToken,
      body: { platform: 'ios', device_token: 'device-admin', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member),
      body: { title: 'first', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // When a second notification is sent ten minutes later
    vi.setSystemTime(T0 + 600_000)
    const memberToken = await tokenFor(env, team.member, T0 + 600_000)
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'second', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then the same provider token was reused
    const pushes = outbound.calls.filter((call) => call.url.includes('/3/device/'))
    expect(pushes).toHaveLength(2)
    expect(pushes[1]?.headers.authorization).toBe(pushes[0]?.headers.authorization)
  })

  it('provider token is re-signed after the cache window', async () => {
    // Given one delivered notification
    const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
    const env = createEnv(outbound.transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    await api(env, 'POST', '/api/v1/push-tokens', {
      token: adminToken,
      body: { platform: 'ios', device_token: 'device-admin', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member),
      body: { title: 'first', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // When the next notification happens after the cache window closed
    vi.setSystemTime(T0 + APNS_JWT_TTL_MS + 1000)
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member, T0 + APNS_JWT_TTL_MS + 1000),
      body: { title: 'second', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then a fresh token was signed with a later issue time
    const pushes = outbound.calls.filter((call) => call.url.includes('/3/device/'))
    expect(pushes[1]?.headers.authorization).not.toBe(pushes[0]?.headers.authorization)
    const first = decodeJson((pushes[0]?.headers.authorization ?? '').replace(/^bearer /, '').split('.')[1] as string)
    const second = decodeJson((pushes[1]?.headers.authorization ?? '').replace(/^bearer /, '').split('.')[1] as string)
    expect(second.iat).toBeGreaterThan(first.iat)
  })

  it('stale device token answering 410 is purged from the database', async () => {
    // Given a registered device APNs reports as unregistered
    const outbound = externalTransport({
      github: { accounts: [OCTOCAT, HUBOT] },
      apns: { unregistered: ['device-stale'] },
    })
    const env = createEnv(outbound.transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    await api(env, 'POST', '/api/v1/push-tokens', {
      token: adminToken,
      body: { platform: 'ios', device_token: 'device-stale', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })

    // When a notification is sent to it
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member),
      body: { title: 'goes nowhere', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then the device token is gone
    const stored = await one<{ id: string }>(env, 'SELECT id FROM push_tokens WHERE device_token = ?', 'device-stale')
    expect(stored).toBeNull()
  })
})
