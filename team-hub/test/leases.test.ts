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
import { LEASE_DURATION_MS } from '../src/constants'
import { sweepAllTeams } from '../src/domain/sweep'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

interface AgentIssueFixture {
  env: Env
  teamId: string
  issueId: string
  hostId: string
  hostToken: string
  otherHostId: string
  otherHostToken: string
  memberToken: string
  adminToken: string
}

/** A team, two online hosts with one agent each, and one issue for host A's agent. */
async function agentIssue(): Promise<AgentIssueFixture> {
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
  await api(env, 'POST', '/api/v1/push-tokens', {
    token: memberToken,
    body: { platform: 'ios', device_token: 'device-member', bundle_id: 'com.example.whale', environment: 'sandbox' },
  })
  const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
    token: memberToken,
    body: { title: 'Run the suite', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
  })
  return {
    env,
    teamId: team.teamId,
    issueId: created.body.issue.id as string,
    hostId: hostA.hostId,
    hostToken: hostA.hostToken,
    otherHostId: hostB.hostId,
    otherHostToken: hostB.hostToken,
    memberToken,
    adminToken,
  }
}

function claimPath(teamId: string, issueId: string): string {
  return '/api/v1/teams/' + teamId + '/issues/' + issueId + '/claim'
}

describe('claiming a lease', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host claims the card of its own agent and receives a 60 second lease', async () => {
    // Given an agent issue waiting for host A
    const fixture = await agentIssue()

    // When host A claims it
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // Then the lease, its expiry and the attempt are returned and stored
    expect(claim.status).toBe(200)
    expect(claim.body.lease_expires_at).toBe(T0 + LEASE_DURATION_MS)
    expect(claim.body.execution_attempt_id).toMatch(/[0-9a-f-]{36}/)
    const stored = await one<{ status: string; lease_token: string; executing_host_id: string }>(
      fixture.env,
      'SELECT status, lease_token, executing_host_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toMatchObject({ status: 'running', executing_host_id: fixture.hostId })
    expect(stored?.lease_token).toBe(claim.body.lease_token)
  })

  it('operator sees another host refused the claim so the card never migrates', async () => {
    // Given an agent issue assigned to host A's agent while host A is offline
    const fixture = await agentIssue()
    await fixture.env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").bind(fixture.hostId).run()
    await sweepAllTeams(fixture.env, T0 + 1)

    // When a different host tries to claim it
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.otherHostToken,
      body: {},
    })

    // Then the claim is refused and the card still waits for its own host
    expect(claim.status).toBe(403)
    expect(claim.body.error.code).toBe('HOST_MISMATCH')
    const stored = await one<{ status: string; assignee_agent_id: string }>(
      fixture.env,
      'SELECT status, assignee_agent_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored?.status).toBe('waiting_host')
  })

  it('host is given a hub minted attempt id on a fresh claim', async () => {
    // Given an agent card and a Host that offers its own attempt identifier
    const fixture = await agentIssue()

    // When it claims the card with that identifier
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { execution_attempt_id: 'host-chosen-attempt' },
    })

    // Then the hub mints a new attempt of its own, so an old identifier can
    // never be recycled into a fresh execution
    expect(claim.status).toBe(200)
    expect(claim.body.execution_attempt_id).not.toBe('host-chosen-attempt')
    expect(claim.body.execution_attempt_id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    const stored = await one<{ execution_attempt_id: string }>(
      fixture.env,
      'SELECT execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored?.execution_attempt_id).toBe(claim.body.execution_attempt_id)
  })

  it('host is refused a claim while another attempt holds the lease', async () => {
    // Given a claimed issue
    const fixture = await agentIssue()
    const first = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the same host claims again without presenting the attempt credentials
    const second = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // Then the lease is reported as held by another execution attempt
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('LEASE_HELD_BY_OTHER')
    expect(first.body.lease_token).not.toBe(second.body.lease_token)
  })

  it('host reconnects with its attempt credentials and gets the same execution back', async () => {
    // Given a claimed issue with one recorded claim
    const fixture = await agentIssue()
    const first = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the host reconnects presenting the same attempt and lease token
    const reconnected = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {
        execution_attempt_id: first.body.execution_attempt_id,
        lease_token: first.body.lease_token,
      },
    })

    // Then the same attempt comes back and no second claim is recorded
    expect(reconnected.status).toBe(200)
    expect(reconnected.body.execution_attempt_id).toBe(first.body.execution_attempt_id)
    expect(reconnected.body.lease_token).toBe(first.body.lease_token)
    expect(reconnected.body.lease_expires_at).toBe(T0 + LEASE_DURATION_MS)
    const claims = await all<{ activity_type: string }>(
      fixture.env,
      "SELECT activity_type FROM activity WHERE issue_id = ? AND activity_type = 'issue.claimed'",
      fixture.issueId,
    )
    expect(claims).toHaveLength(1)
  })

  it('host resumes its attempt after the lease lapsed and the hub stepped back', async () => {
    // Given a claimed issue whose lease expired and was swept back
    const fixture = await agentIssue()
    const first = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    vi.setSystemTime(T0 + LEASE_DURATION_MS + 1)
    await sweepAllTeams(fixture.env, T0 + LEASE_DURATION_MS + 1)
    const waiting = await one<{ status: string }>(fixture.env, 'SELECT status FROM issues WHERE id = ?', fixture.issueId)
    expect(waiting?.status).toBe('waiting_host')

    // When the host reconnects with its previous attempt credentials
    const resumed = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {
        execution_attempt_id: first.body.execution_attempt_id,
        lease_token: first.body.lease_token,
      },
    })

    // Then the same attempt is re-established instead of a duplicate execution
    expect(resumed.status).toBe(200)
    expect(resumed.body.execution_attempt_id).toBe(first.body.execution_attempt_id)
    expect(resumed.body.lease_expires_at).toBe(T0 + LEASE_DURATION_MS + 1 + LEASE_DURATION_MS)
    const stored = await one<{ status: string; execution_attempt_id: string }>(
      fixture.env,
      'SELECT status, execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toMatchObject({ status: 'running' })
    expect(stored?.execution_attempt_id).toBe(first.body.execution_attempt_id)
  })

  it('host is refused a claim on a todo issue', async () => {
    // Given an agent card that nobody assigned yet
    const fixture = await agentIssue()
    await fixture.env.DB.prepare("UPDATE issues SET status = 'todo' WHERE id = ?").bind(fixture.issueId).run()

    // When the host claims it
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // Then the state machine refuses the claim
    expect(claim.status).toBe(422)
    expect(claim.body.error.code).toBe('INVALID_STATE_TRANSITION')
    expect(claim.body.error.details.status).toBe('todo')
  })

  it('host is refused a claim on a failed issue', async () => {
    // Given an agent card whose last run failed
    const fixture = await agentIssue()
    await fixture.env.DB.prepare("UPDATE issues SET status = 'failed' WHERE id = ?").bind(fixture.issueId).run()

    // When the host claims it instead of waiting for a retry
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // Then the claim is refused
    expect(claim.status).toBe(422)
    expect(claim.body.error.details.status).toBe('failed')
  })

  it('operator sees exactly one winner when two claims race for the same card', async () => {
    // Given one agent card that two simultaneous claims aim at
    const fixture = await agentIssue()

    // When both claims arrive together
    const [first, second] = await Promise.all([
      api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), { token: fixture.hostToken, body: {} }),
      api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), { token: fixture.hostToken, body: {} }),
    ])

    // Then one claim owns the card and the other is refused
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    const claims = await all<{ activity_type: string }>(
      fixture.env,
      "SELECT activity_type FROM activity WHERE issue_id = ? AND activity_type = 'issue.claimed'",
      fixture.issueId,
    )
    expect(claims).toHaveLength(1)
    const stored = await one<{ status: string; execution_attempt_id: string }>(
      fixture.env,
      'SELECT status, execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    const winner = first.status === 200 ? first : second
    expect(stored).toMatchObject({ status: 'running' })
    expect(stored?.execution_attempt_id).toBe(winner.body.execution_attempt_id)
  })

  it('host is refused a claim on an issue that is already done', async () => {
    // Given an agent issue that a human canceled
    const fixture = await agentIssue()
    await api(fixture.env, 'PATCH', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId, {
      token: fixture.memberToken,
      body: { status: 'canceled' },
    })

    // When the host tries to claim it
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // Then the state machine refuses the claim
    expect(claim.status).toBe(422)
    expect(claim.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })
})

describe('lease renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host renews its lease and the expiry moves one lease further', async () => {
    // Given a claimed issue
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the host renews at the renewal cadence
    vi.setSystemTime(T0 + 20_000)
    const renewed = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/renew-lease',
      { token: fixture.hostToken, body: { lease_token: claim.body.lease_token } },
    )

    // Then the lease lives until 60 seconds after the renewal
    expect(renewed.status).toBe(200)
    expect(renewed.body.lease_expires_at).toBe(T0 + 20_000 + LEASE_DURATION_MS)
  })

  it('host is refused renewal once the lease expired and the card stepped back', async () => {
    // Given a claimed issue whose lease lapsed
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    vi.setSystemTime(T0 + LEASE_DURATION_MS + 1)

    // When the host renews too late
    const renewed = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/renew-lease',
      { token: fixture.hostToken, body: { lease_token: claim.body.lease_token } },
    )

    // Then the hub reports the expired lease and parks the card
    expect(renewed.status).toBe(412)
    expect(renewed.body.error.code).toBe('LEASE_EXPIRED')
    const stored = await one<{ status: string }>(fixture.env, 'SELECT status FROM issues WHERE id = ?', fixture.issueId)
    expect(stored?.status).toBe('waiting_host')
  })

  it('host is refused renewal with a lease token it does not hold', async () => {
    // Given a claimed issue
    const fixture = await agentIssue()
    await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the host presents a different lease token
    const renewed = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/renew-lease',
      { token: fixture.hostToken, body: { lease_token: 'not-the-lease' } },
    )

    // Then the renewal is refused as expired
    expect(renewed.status).toBe(412)
    expect(renewed.body.error.code).toBe('LEASE_EXPIRED')
  })
})

describe('settlement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host writes back success and the issue waits for the human reviewer', async () => {
    // Given a claimed issue
    const fixture = await agentIssue()
    await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the host settles with success and its summary
    const settled = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'succeeded', summary: 'all tests green' } },
    )

    // Then the collaboration status is in_review with the summary stored
    expect(settled.status).toBe(200)
    expect(settled.body).toEqual({ ok: true, status: 'in_review' })
    const stored = await one<{ status: string; execution_summary: string; lease_token: string | null }>(
      fixture.env,
      'SELECT status, execution_summary, lease_token FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toMatchObject({ status: 'in_review', execution_summary: 'all tests green', lease_token: null })
    const activity = await all<{ activity_type: string }>(
      fixture.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      fixture.issueId,
    )
    expect(activity.map((row) => row.activity_type)).toContain('issue.settled_in_review')
  })

  it('host writes back failure and the issue carries the failure text', async () => {
    // Given a claimed issue
    const fixture = await agentIssue()
    await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When the host settles with a failure
    const settled = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'failed', error: 'suite exploded' } },
    )

    // Then the issue is failed with the error recorded
    expect(settled.body.status).toBe('failed')
    const stored = await one<{ status: string; failure_error: string }>(
      fixture.env,
      'SELECT status, failure_error FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toEqual({ status: 'failed', failure_error: 'suite exploded' })
  })

  it('host settlement after the lease lapsed is accepted for the same attempt', async () => {
    // Given a claimed issue whose lease lapsed while the host was offline
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    vi.setSystemTime(T0 + LEASE_DURATION_MS + 1)
    await sweepAllTeams(fixture.env, T0 + LEASE_DURATION_MS + 1)

    // When the host writes back with the attempt it had already finished
    const settled = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      {
        token: fixture.hostToken,
        body: { outcome: 'succeeded', summary: 'finished before reconnect', execution_attempt_id: claim.body.execution_attempt_id },
      },
    )

    // Then the write-back lands instead of being lost to the expired lease
    expect(settled.status).toBe(200)
    expect(settled.body.status).toBe('in_review')
  })

  it('host settlement without attempt credentials after the lease lapsed is refused', async () => {
    // Given a claimed issue whose lease lapsed
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    expect(claim.status).toBe(200)
    vi.setSystemTime(T0 + LEASE_DURATION_MS + 1)

    // When the host settles without naming the attempt
    const settled = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'succeeded' } },
    )

    // Then the hub reports the expired lease
    expect(settled.status).toBe(412)
    expect(settled.body.error.code).toBe('LEASE_EXPIRED')
  })

  it('host sees the pending rework signal on the issue and settlement clears it', async () => {
    // Given a card whose review was rejected, so it carries rework instructions
    const fixture = await agentIssue()
    const claimed = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle', {
      token: fixture.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: claimed.body.execution_attempt_id },
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject', {
      token: fixture.memberToken,
      body: { instructions: 'Add the regression test' },
    })

    // When the host finds it through the issue list, claims it and settles
    const listed = await api(fixture.env, 'GET', '/api/v1/teams/' + fixture.teamId + '/issues', {
      token: fixture.hostToken,
      query: { status: 'assigned' },
    })
    const pending = listed.body.issues.find((issue: { id: string }) => issue.id === fixture.issueId)
    const rework = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle', {
      token: fixture.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: rework.body.execution_attempt_id },
    })

    // Then the signal was visible while assigned and is gone after the run
    expect(pending).toMatchObject({ status: 'assigned', rework_instructions: 'Add the regression test' })
    const stored = await one<{ status: string; rework_instructions: string | null }>(
      fixture.env,
      'SELECT status, rework_instructions FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toEqual({ status: 'in_review', rework_instructions: null })
  })

  it('host settlement from a previous attempt is refused after a rework round', async () => {
    // Given a card that settled once, was rejected, and is running again under a new attempt
    const fixture = await agentIssue()
    const first = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle', {
      token: fixture.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: first.body.execution_attempt_id },
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject', {
      token: fixture.memberToken,
      body: { instructions: 'Try again' },
    })
    const second = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    expect(second.body.execution_attempt_id).not.toBe(first.body.execution_attempt_id)

    // When the first attempt's settlement arrives late
    const late = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'succeeded', execution_attempt_id: first.body.execution_attempt_id } },
    )

    // Then it is refused and the second run is left running
    expect(late.status).toBe(412)
    expect(late.body.error.code).toBe('LEASE_EXPIRED')
    const stored = await one<{ status: string; execution_attempt_id: string }>(
      fixture.env,
      'SELECT status, execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toMatchObject({ status: 'running' })
    expect(stored?.execution_attempt_id).toBe(second.body.execution_attempt_id)
  })

  it('operator sees a retried card start from a clean attempt and lease', async () => {
    // Given a card whose run failed
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle', {
      token: fixture.hostToken,
      body: { outcome: 'failed', error: 'suite exploded', execution_attempt_id: claim.body.execution_attempt_id },
    })

    // When a human retries it
    const retried = await api(fixture.env, 'PATCH', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId, {
      token: fixture.memberToken,
      body: { status: 'assigned' },
    })

    // Then the failed attempt and its lease are gone, so nothing of that round
    // can be settled against the next one
    expect(retried.status).toBe(200)
    const stored = await one<{
      status: string
      execution_attempt_id: string | null
      lease_token: string | null
      lease_expires_at: number | null
    }>(
      fixture.env,
      'SELECT status, execution_attempt_id, lease_token, lease_expires_at FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toEqual({
      status: 'assigned',
      execution_attempt_id: null,
      lease_token: null,
      lease_expires_at: null,
    })
    const lateSettle = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id } },
    )
    expect(lateSettle.status).toBe(412)
  })

  it('host settlement is idempotent when replayed', async () => {
    // Given a settled issue
    const fixture = await agentIssue()
    const claim = await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle', {
      token: fixture.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id },
    })

    // When the same settlement is replayed
    const replay = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.hostToken, body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id } },
    )

    // Then the same status comes back without a second transition
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ ok: true, status: 'in_review' })
    const activity = await all<{ activity_type: string }>(
      fixture.env,
      "SELECT activity_type FROM activity WHERE issue_id = ? AND activity_type = 'issue.settled_in_review'",
      fixture.issueId,
    )
    expect(activity).toHaveLength(1)
  })

  it('host is refused settlement from another host', async () => {
    // Given an issue claimed by host A
    const fixture = await agentIssue()
    await api(fixture.env, 'POST', claimPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {},
    })

    // When host B submits a settlement
    const settled = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/settle',
      { token: fixture.otherHostToken, body: { outcome: 'succeeded' } },
    )

    // Then the host binding refuses it
    expect(settled.status).toBe(403)
    expect(settled.body.error.code).toBe('HOST_MISMATCH')
  })
})