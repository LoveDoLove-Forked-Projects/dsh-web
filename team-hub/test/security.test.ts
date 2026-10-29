import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  all,
  api,
  createEnv,
  externalTransport,
  one,
  seedHost,
  seedTeam,
  T0,
  tokenFor,
  type GithubAccount,
} from './helpers'
import { routeInventories } from '../src/router'
import { sweepAllTeams } from '../src/domain/sweep'
import { RATE_LIMIT_AUTH_PER_IP, RATE_LIMIT_HOST, RATE_LIMIT_MEMBER, REQUEST_BODY_LIMIT_BYTES } from '../src/constants'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

describe('invariant: tool permission approvals never enter the hub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member finds no endpoint that could carry a permission approval', async () => {
    // Given the complete route table the worker serves
    const routes = routeInventories()

    // When every path is inspected for tool permission vocabulary
    const offenders = routes.filter((route) => /permission|consent|sandbox|tool/i.test(route.path))
    const approveRoutes = routes.filter((route) => /approv/i.test(route.path))

    // Then the only approval route is the human review gate
    expect(offenders).toEqual([])
    expect(approveRoutes.map((route) => route.path)).toEqual([
      '/api/v1/teams/:teamId/issues/:issueId/review/approve',
    ])
  })

  it('member finds no table or column that could store a permission approval', async () => {
    // Given the migrated database, read through its own DDL
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const schema = await all<{ name: string; sql: string }>(
      env,
      'SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL',
    )
    const ddl = schema.map((entry) => entry.sql).join('\n')

    // When the whole schema text is inspected for tool permission vocabulary
    const offenders = schema.filter((entry) => /permission|consent|approv|grant/i.test(entry.sql))

    // Then the schema stores collaboration state only
    expect(offenders.map((entry) => entry.name)).toEqual([])
    expect(schema.map((entry) => entry.name)).toContain('questions')
    expect(ddl).toContain('CREATE TABLE questions')
  })

  it('member gets a normal not found answer for an approval style path', async () => {
    // Given a seeded team
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When a client probes a tool permission endpoint
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/approvals', {
      token,
      body: { tool: 'bash', decision: 'allow' },
    })

    // Then the hub has no such surface
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('NOT_FOUND')
  })
})

describe('invariant: an offline execution node never migrates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('operator sees the card wait for its own host while every other host is refused', async () => {
    // Given an agent card whose bound host went offline
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const memberToken = await tokenFor(env, team.member)
    const hostA = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const hostB = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-b',
      agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
    })
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'bound to host a', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
    })
    const issueId = created.body.issue.id as string
    await env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").bind(hostA.hostId).run()

    // When the hub sweeps and every other principal tries to take the card
    await sweepAllTeams(env, T0 + 1)
    const byOtherHost = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
      token: hostB.hostToken,
      body: {},
    })
    const byMember = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
      token: memberToken,
      body: {},
    })
    await sweepAllTeams(env, T0 + 600_000)

    // Then the card stays in waiting_host with the original assignee
    expect(byOtherHost.status).toBe(403)
    expect(byOtherHost.body.error.code).toBe('HOST_MISMATCH')
    expect(byMember.status).toBe(403)
    const stored = await one<{ status: string; assignee_agent_id: string; executing_host_id: string | null }>(
      env,
      'SELECT status, assignee_agent_id, executing_host_id FROM issues WHERE id = ?',
      issueId,
    )
    expect(stored).toEqual({
      status: 'waiting_host',
      assignee_agent_id: hostA.agents[0]?.id as string,
      executing_host_id: null,
    })
  })

  it('operator sees the card run again once its own host returns', async () => {
    // Given a card that waited while its host was offline
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const hostA = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: await tokenFor(env, team.member),
      body: { title: 'come back later', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
    })
    const issueId = created.body.issue.id as string
    await env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").bind(hostA.hostId).run()
    await sweepAllTeams(env, T0 + 1)

    // When its own host heartbeats and claims the card
    const heartbeat = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/' + hostA.hostId + '/heartbeat', {
      token: hostA.hostToken,
    })
    const claim = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
      token: hostA.hostToken,
      body: {},
    })

    // Then the same host takes it into running
    expect(heartbeat.status).toBe(200)
    expect(claim.status).toBe(200)
    const stored = await one<{ status: string; executing_host_id: string }>(
      env,
      'SELECT status, executing_host_id FROM issues WHERE id = ?',
      issueId,
    )
    expect(stored).toEqual({ status: 'running', executing_host_id: hostA.hostId })
  })
})

describe('role based access control', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('operator sees the matrix enforced for the guarded endpoint groups', async () => {
    // Given one team with a member session, a host token and no credentials
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const memberToken = await tokenFor(env, team.member)
    const host = await seedHost(env, team.teamId, await tokenFor(env, team.admin), {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const base = '/api/v1/teams/' + team.teamId

    // When each principal kind calls each guarded group
    const anonymousRoster = await api(env, 'GET', base + '/members')
    const memberRoster = await api(env, 'GET', base + '/members', { token: memberToken })
    const hostRoster = await api(env, 'GET', base + '/members', { token: host.hostToken })
    const hostIssueCreation = await api(env, 'POST', base + '/issues', { token: host.hostToken, body: { title: 'x' } })
    const memberHostTokenMint = await api(env, 'POST', base + '/hosts/tokens', { token: memberToken, body: { hostname: 'h' } })
    const memberClaim = await api(env, 'POST', base + '/issues/issue_missing/claim', { token: memberToken, body: {} })
    const hostIdentity = await api(env, 'GET', '/api/v1/me', { token: host.hostToken })

    // Then every denial follows the section 11 matrix
    expect(anonymousRoster.status).toBe(401)
    expect(memberRoster.status).toBe(200)
    expect(hostRoster.status).toBe(403)
    expect(hostIssueCreation.status).toBe(403)
    expect(memberHostTokenMint.status).toBe(403)
    expect(memberClaim.status).toBe(403)
    expect(hostIdentity.status).toBe(403)
  })

  it('member cannot update or delete activity records', async () => {
    // Given an issue with one audit row
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)
    const issue = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', { token, body: { title: 'audited' } })
    const activity = await one<{ id: string }>(env, 'SELECT id FROM activity WHERE issue_id = ?', issue.body.issue.id)

    // When the member tries to rewrite or remove the audit record
    const deleted = await api(env, 'DELETE', '/api/v1/teams/' + team.teamId + '/activity/' + activity?.id, { token })
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/activity/' + activity?.id, {
      token,
      body: { payload: 'tampered' },
    })

    // Then no such endpoint exists and the row is untouched
    expect(deleted.status).toBe(404)
    expect(patched.status).toBe(404)
    const stored = await one<{ id: string }>(env, 'SELECT id FROM activity WHERE id = ?', activity?.id as string)
    expect(stored?.id).toBe(activity?.id)
  })
})

describe('quotas and payload caps', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member is throttled after the member quota of 120 requests per minute', async () => {
    // Given a member session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the member makes the allowed number of requests and one more
    let allowed = 0
    for (let index = 0; index < RATE_LIMIT_MEMBER; index += 1) {
      const response = await api(env, 'GET', '/api/v1/me', { token })
      if (response.status === 200) allowed += 1
    }
    const throttled = await api(env, 'GET', '/api/v1/me', { token })

    // Then the last one is a rate limit answer
    expect(allowed).toBe(RATE_LIMIT_MEMBER)
    expect(throttled.status).toBe(429)
    expect(throttled.body.error.code).toBe('RATE_LIMITED')
  })

  it('host is throttled after the host quota of 30 requests per minute', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const host = await seedHost(env, team.teamId, await tokenFor(env, team.admin), { hostname: 'host-a', agents: [] })
    const path = '/api/v1/teams/' + team.teamId + '/hosts/' + host.hostId + '/heartbeat'

    // When the window rolls over and it heartbeats more often than the quota allows
    vi.setSystemTime(T0 + 60_001)
    let allowed = 0
    for (let index = 0; index < RATE_LIMIT_HOST; index += 1) {
      const response = await api(env, 'POST', path, { token: host.hostToken })
      if (response.status === 200) allowed += 1
    }
    const throttled = await api(env, 'POST', path, { token: host.hostToken })

    // Then the extra heartbeat is rate limited
    expect(allowed).toBe(RATE_LIMIT_HOST)
    expect(throttled.status).toBe(429)
  })

  it('guest is throttled on the authentication routes per client ip', async () => {
    // Given an unauthenticated client
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    await seedTeam(env)

    // When it hammers the token endpoint past the auth quota
    let rejected = 0
    for (let index = 0; index < RATE_LIMIT_AUTH_PER_IP; index += 1) {
      const response = await api(env, 'POST', '/auth/token', {
        body: { code: 'nobody', code_verifier: 'v', redirect_uri: 'whale://auth/callback' },
      })
      if (response.status === 400) rejected += 1
    }
    const throttled = await api(env, 'POST', '/auth/token', {
      body: { code: 'nobody', code_verifier: 'v', redirect_uri: 'whale://auth/callback' },
    })

    // Then the next attempt is refused as a rate limit
    expect(rejected).toBe(RATE_LIMIT_AUTH_PER_IP)
    expect(throttled.status).toBe(429)
    expect(throttled.body.error.code).toBe('RATE_LIMITED')
  })

  it('member is refused a request body above 128 KiB', async () => {
    // Given a member session
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const token = await tokenFor(env, team.member)

    // When the body exceeds the total request cap
    const oversized = 'x'.repeat(REQUEST_BODY_LIMIT_BYTES + 1)
    const response = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token,
      rawBody: JSON.stringify({ title: 'big', description: oversized }),
    })

    // Then the request is refused as too large
    expect(response.status).toBe(413)
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})