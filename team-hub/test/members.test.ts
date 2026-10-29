import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  createEnv,
  externalTransport,
  iosLogin,
  one,
  seedHost,
  seedTeam,
  T0,
  tokenFor,
  type GithubAccount,
} from './helpers'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: 'https://img/octo.png' }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: 'https://img/hubot.png' }
const NEWCOMER: GithubAccount = { id: 1003, login: 'newcomer', name: 'New Comer', avatar_url: 'https://img/new.png' }

describe('team members', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member lists the team roster with their roles', async () => {
    // Given a seeded team with an admin and a member
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the member reads the roster
    const result = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/members', { token })

    // Then both memberships come back with their roles
    expect(result.status).toBe(200)
    expect(result.body.members.map((entry: { github_username: string }) => entry.github_username)).toEqual([
      'octocat',
      'hubot',
    ])
    expect(result.body.members[0].role).toBe('admin')
  })

  it('admin invites a GitHub user who then appears as invited', async () => {
    // Given a team whose admin holds a session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT, NEWCOMER] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.admin)

    // When the admin invites a GitHub username as a plain member
    const invited = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/members/invite', {
      token,
      body: { github_username: 'newcomer', role: 'member' },
    })

    // Then the member row exists in the invited state with the GitHub ids bound
    expect(invited.status).toBe(201)
    expect(invited.body.member.status).toBe('invited')
    expect(invited.body.member.github_user_id).toBe(1003)
    const stored = await one<{ status: string; github_user_id: number }>(
      env,
      'SELECT status, github_user_id FROM members WHERE id = ?',
      invited.body.member.id,
    )
    expect(stored).toEqual({ status: 'invited', github_user_id: 1003 })
  })

  it('member is refused the invite endpoint without the admin role', async () => {
    // Given a plain member with a session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT, NEWCOMER] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When that member tries to invite somebody
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/members/invite', {
      token,
      body: { github_username: 'newcomer', role: 'member' },
    })

    // Then the request is forbidden
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('FORBIDDEN')
  })

  it('admin is told the GitHub user does not exist', async () => {
    // Given an admin session and a GitHub fake that knows only two accounts
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.admin)

    // When the admin invites an unknown username
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/members/invite', {
      token,
      body: { github_username: 'ghost', role: 'member' },
    })

    // Then the missing GitHub account is reported as not found
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('USER_NOT_FOUND')
  })

  it('admin is told the invitee is already a member', async () => {
    // Given a team that already contains hubot
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.admin)

    // When the admin invites hubot again
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/members/invite', {
      token,
      body: { github_username: 'hubot', role: 'member' },
    })

    // Then the duplicate membership is a conflict
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('ALREADY_MEMBER')
  })

  it('invited member becomes active on their first GitHub login', async () => {
    // Given an invited member and a GitHub account for them
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT, NEWCOMER] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const invited = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/members/invite', {
      token: adminToken,
      body: { github_username: 'newcomer', role: 'member' },
    })

    // When that person completes the iOS login
    const login = await iosLogin(env, 'newcomer')

    // Then the membership is active and the session belongs to it
    expect(login.status).toBe(200)
    expect(login.body.member.id).toBe(invited.body.member.id)
    const stored = await one<{ status: string }>(env, 'SELECT status FROM members WHERE id = ?', invited.body.member.id)
    expect(stored?.status).toBe('active')
  })

  it('admin removes a member and that session stops working at once', async () => {
    // Given a member with a live session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const memberToken = await tokenFor(env, team.member)

    // When the admin removes the member
    const removed = await api(env, 'DELETE', '/api/v1/teams/' + team.teamId + '/members/' + team.member.id, {
      token: adminToken,
    })

    // Then the membership is suspended and the member token no longer works
    expect(removed.status).toBe(200)
    const stored = await one<{ status: string }>(env, 'SELECT status FROM members WHERE id = ?', team.member.id)
    expect(stored?.status).toBe('suspended')
    const after = await api(env, 'GET', '/api/v1/me', { token: memberToken })
    expect(after.status).toBe(401)
  })

  it('admin is told the member to remove does not exist', async () => {
    // Given an admin session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)

    // When the admin removes an unknown member id
    const result = await api(env, 'DELETE', '/api/v1/teams/' + team.teamId + '/members/mem_unknown', {
      token: adminToken,
    })

    // Then the missing member is reported
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('MEMBER_NOT_FOUND')
  })
})

describe('host tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('admin mints a host token that is stored only as a hash', async () => {
    // Given an admin session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.admin)

    // When the admin mints a Host token
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token,
      body: { hostname: 'macbook-pro' },
    })

    // Then the plaintext is returned once and the row holds only its hash
    expect(result.status).toBe(201)
    expect(result.body.host_token).toMatch(/^th_host_[0-9a-f]{64}$/)
    const stored = await one<{ token_hash: string; status: string }>(
      env,
      'SELECT token_hash, status FROM hosts WHERE id = ?',
      result.body.host_id,
    )
    expect(stored?.status).toBe('offline')
    expect(stored?.token_hash).not.toContain('th_host_')
    expect(stored?.token_hash).toHaveLength(64)
  })

  it('member is refused Host token minting', async () => {
    // Given a plain member session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the member tries to mint a Host token
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token,
      body: { hostname: 'macbook-pro' },
    })

    // Then the request is forbidden
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('FORBIDDEN')
  })

  it('host token cannot read the member roster', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When the Host asks for the roster
    const result = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/members', { token: host.hostToken })

    // Then the Host token has no permission for it
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('FORBIDDEN')
  })

  it('admin revokes a host token and it stops authenticating', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When the admin revokes its token
    const revoked = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/' + host.hostId + '/revoke-token', {
      token: adminToken,
    })

    // Then the Host token is rejected afterwards
    expect(revoked.status).toBe(200)
    const heartbeat = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/' + host.hostId + '/heartbeat', {
      token: host.hostToken,
    })
    expect(heartbeat.status).toBe(401)
    const stored = await one<{ status: string }>(env, 'SELECT status FROM hosts WHERE id = ?', host.hostId)
    expect(stored?.status).toBe('revoked')
  })

  it('admin is told the host to revoke does not exist', async () => {
    // Given an admin session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)

    // When the admin revokes an unknown host
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/host_unknown/revoke-token', {
      token: adminToken,
    })

    // Then the missing host is reported
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('HOST_NOT_FOUND')
  })
})