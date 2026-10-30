import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEASE_DURATION_MS, QUESTION_TTL_MS } from '../../src/constants'
import { loadConfig, SESSION_KEY_ENV } from '../src/config'
import { createSweeper } from '../src/scheduler'
import { api, createIssue, one, seedHost, seedTeam, startTestHub, type TestHub } from './helpers'

/**
 * Registration, heartbeat, claim, renewal and settlement against the real
 * service: real HTTP, real SQLite, real leases. Each case asserts the wire
 * response and the row the state machine left behind.
 */

let active: TestHub | null = null

afterEach(async () => {
  if (active !== null) await active.close()
  active = null
})

async function started(options?: Parameters<typeof startTestHub>[0]): Promise<TestHub> {
  active = await startTestHub(options)
  return active
}

describe('service health', () => {
  it('reports liveness, readiness and the schema it applied', async () => {
    const hub = await started()

    const health = await api(hub, 'GET', '/healthz')
    expect(health.status).toBe(200)
    expect(health.body.status).toBe('ok')
    expect(health.body.protocol_version).toBe('1.0.0')

    const ready = await api(hub, 'GET', '/readyz')
    expect(ready.status).toBe(200)
    expect(ready.body.status).toBe('ready')
    expect(ready.body.database).toBe('ok')
    expect(ready.body.migrations.applied).toBe(4)
    expect(ready.body.migrations.pending).toEqual([])
  })

  it('keeps a route closed and says so when its settings are missing', async () => {
    // Given a hub with no GitHub OAuth app
    const hub = await started({ env: { GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined } })

    // When the browser entry point is called
    const authorize = await api(hub, 'GET', '/auth/github/authorize', {
      query: { client: 'web', redirect_uri: hub.baseUrl + '/app', state: 'x'.repeat(43) },
    })

    // Then it answers NOT_CONFIGURED instead of redirecting to GitHub
    expect(authorize.status).toBe(503)
    expect(authorize.body.error.code).toBe('NOT_CONFIGURED')
  })

  it('refuses to start without the database and the session key', () => {
    const report = loadConfig({})

    expect(report.errors.some((line) => line.includes('DATABASE_PATH'))).toBe(true)
    expect(report.errors.some((line) => line.includes(SESSION_KEY_ENV))).toBe(true)
    expect(report.report.join('\n')).toContain('503 NOT_CONFIGURED')
  })
})

describe('host registration and heartbeat', () => {
  it('registers a host with its agents and answers heartbeats with the hub clock', async () => {
    // Given a team whose admin mints a host token
    const hub = await started()
    const team = await seedTeam(hub)
    const minted = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token: team.admin.accessToken,
      body: { hostname: 'host-a' },
    })
    expect(minted.status).toBe(201)

    // When the host registers with two agent definitions
    const registered = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: minted.body.host_token as string,
      body: {
        hostname: 'host-a',
        client_version: '1.4.0',
        agents: [
          { name: 'qa-bot', preset_id: 'liangshen', model: 'deepseek-v4', reasoning_effort: 'high' },
          { name: 'dev-bot', preset_id: 'liangshen' },
        ],
      },
    })

    // Then the host is online and the agents carry what it reported
    expect(registered.status).toBe(200)
    expect(registered.body.host_id).toBe(minted.body.host_id)
    expect(registered.body.status).toBe('online')
    expect(registered.body.conflicts).toEqual([])
    expect((registered.body.agents as { name: string }[]).map((agent) => agent.name)).toEqual(['qa-bot', 'dev-bot'])
    const hostRow = one<{ status: string; client_version: string }>(
      hub,
      'SELECT status, client_version FROM hosts WHERE id = ?',
      minted.body.host_id,
    )
    expect(hostRow).toEqual({ status: 'online', client_version: '1.4.0' })
    const agentRow = one<{ model: string; reasoning_effort: string }>(
      hub,
      'SELECT model, reasoning_effort FROM agents WHERE name = ?',
      'qa-bot',
    )
    expect(agentRow).toEqual({ model: 'deepseek-v4', reasoning_effort: 'high' })

    // And a heartbeat keeps it online and echoes the server time
    const beat = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/' + minted.body.host_id + '/heartbeat', {
      token: minted.body.host_token as string,
    })
    expect(beat.status).toBe(200)
    expect(beat.body.ok).toBe(true)
    expect(typeof beat.body.server_time).toBe('number')

    // When the same host reports only one agent, the other is marked offline
    const second = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: minted.body.host_token as string,
      body: { hostname: 'host-a', client_version: '1.4.0', agents: [{ name: 'qa-bot', preset_id: 'liangshen' }] },
    })
    expect(second.status).toBe(200)
    const devBot = one<{ status: string }>(hub, 'SELECT status FROM agents WHERE name = ?', 'dev-bot')
    expect(devBot?.status).toBe('offline')
  })
})

describe('claim and settlement', () => {
  async function runningFixture() {
    const hub = await started()
    const team = await seedTeam(hub)
    const hostA = await seedHost(hub, team.teamId, team.admin.accessToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const hostB = await seedHost(hub, team.teamId, team.admin.accessToken, {
      hostname: 'host-b',
      agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
    })
    const issue = await createIssue(hub, team.teamId, team.admin.accessToken, {
      title: 'lease fixture',
      assignee_type: 'agent',
      assignee_id: hostA.agents[0]?.id,
    })
    return { hub, team, hostA, hostB, issue }
  }

  it('refuses a claim another attempt already holds', async () => {
    // Given a card claimed by its host
    const { hub, team, hostA, issue } = await runningFixture()
    const first = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })
    expect(first.status).toBe(200)

    // When the same host claims it again without presenting the running attempt
    const second = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })

    // Then the active lease is reported as held elsewhere, with its expiry
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('LEASE_HELD_BY_OTHER')
    expect(second.body.error.details.lease_expires_at).toBe(first.body.lease_expires_at)
  })

  it('refuses a renewal after the lease expired and steps the card back', async () => {
    // Given a running lease that has just lapsed
    const { hub, team, hostA, issue } = await runningFixture()
    const claim = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })
    expect(claim.status).toBe(200)
    hub.sqlite
      .prepare('UPDATE issues SET lease_expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, issue.id)

    // When the host renews it
    const renewed = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/renew-lease', {
      token: hostA.hostToken,
      body: { lease_token: claim.body.lease_token },
    })

    // Then the renewal is refused and the card waits for its own host again
    expect(renewed.status).toBe(412)
    expect(renewed.body.error.code).toBe('LEASE_EXPIRED')
    const row = one<{ status: string; lease_token: string | null }>(
      hub,
      'SELECT status, lease_token FROM issues WHERE id = ?',
      issue.id,
    )
    expect(row?.status).toBe('waiting_host')

    // And a fresh claim by the bound host starts a new attempt
    const reclaimed = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })
    expect(reclaimed.status).toBe(200)
    expect(reclaimed.body.execution_attempt_id).not.toBe(claim.body.execution_attempt_id)
    expect(reclaimed.body.lease_expires_at - claim.body.lease_expires_at).toBeLessThanOrEqual(LEASE_DURATION_MS)
  })

  it('refuses a claim by a host that does not own the assigned agent', async () => {
    // Given a card assigned to host A's agent
    const { hub, team, hostB, issue } = await runningFixture()

    // When host B tries to claim it
    const claimed = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostB.hostToken,
      body: {},
    })

    // Then the card is not host B's to run
    expect(claimed.status).toBe(403)
    expect(claimed.body.error.code).toBe('HOST_MISMATCH')
    const row = one<{ status: string }>(hub, 'SELECT status FROM issues WHERE id = ?', issue.id)
    expect(row?.status).toBe('assigned')
  })

  it('settles idempotently and refuses a foreign execution attempt', async () => {
    // Given a running card
    const { hub, team, hostA, issue } = await runningFixture()
    const claim = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })
    expect(claim.status).toBe(200)

    // When the host settles it as succeeded
    const settled = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/settle', {
      token: hostA.hostToken,
      body: {
        outcome: 'succeeded',
        summary: 'all checks passed',
        execution_attempt_id: claim.body.execution_attempt_id,
      },
    })

    // Then the card enters review
    expect(settled.status).toBe(200)
    expect(settled.body).toEqual({ ok: true, status: 'in_review' })

    // And a replayed settlement answers the same thing without writing again
    const replay = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/settle', {
      token: hostA.hostToken,
      body: {
        outcome: 'succeeded',
        summary: 'all checks passed',
        execution_attempt_id: claim.body.execution_attempt_id,
      },
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ ok: true, status: 'in_review' })
    const settlements = one<{ n: number }>(
      hub,
      "SELECT COUNT(*) AS n FROM activity WHERE issue_id = ? AND activity_type = 'issue.settled_in_review'",
      issue.id,
    )
    expect(settlements?.n).toBe(1)

    // And a settlement that names an attempt the hub never recorded for this
    // card is refused, so a late write-back cannot overwrite the result
    const foreign = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/settle', {
      token: hostA.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: 'attempt-from-an-earlier-round' },
    })
    expect(foreign.status).toBe(412)
    expect(foreign.body.error.code).toBe('LEASE_EXPIRED')
    expect(foreign.body.error.message).toContain('not the one running')
  })

  it('refuses a settlement from an attempt that is not the running one', async () => {
    // Given a running card whose settlement arrives with another attempt id
    const { hub, team, hostA, issue } = await runningFixture()
    await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: hostA.hostToken,
      body: {},
    })

    // When a settlement names an attempt the hub never minted for this run
    const settled = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/settle', {
      token: hostA.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: 'stale-attempt' },
    })

    // Then the lease is what expired, not the card's state
    expect(settled.status).toBe(412)
    expect(settled.body.error.code).toBe('LEASE_EXPIRED')
  })
})

describe('questions and the process timer', () => {
  it('expires a pending question when the timer sweep runs', async () => {
    // Given a running card and a pending question whose TTL has lapsed
    const hub = await started()
    const team = await seedTeam(hub)
    const host = await seedHost(hub, team.teamId, team.admin.accessToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const issue = await createIssue(hub, team.teamId, team.admin.accessToken, {
      title: 'question ttl',
      assignee_type: 'agent',
      assignee_id: host.agents[0]?.id,
    })
    await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: host.hostToken,
      body: {},
    })
    const asked = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/questions', {
      token: host.hostToken,
      body: { question_text: 'still there?' },
    })
    expect(asked.status).toBe(201)
    hub.sqlite
      .prepare('UPDATE questions SET expires_at = ? WHERE id = ?')
      .run(Date.now() - QUESTION_TTL_MS, asked.body.question.id)

    // When the in-process sweep runs, as the one-minute timer would
    await hub.hub.sweep()

    // Then the question is expired and the card still runs
    const row = one<{ status: string }>(hub, 'SELECT status FROM questions WHERE id = ?', asked.body.question.id)
    expect(row?.status).toBe('expired')
  })

  it('runs the sweep from the process timer, not only at startup', async () => {
    // Given a pending question that has already lapsed
    const hub = await started()
    const team = await seedTeam(hub)
    const host = await seedHost(hub, team.teamId, team.admin.accessToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const issue = await createIssue(hub, team.teamId, team.admin.accessToken, {
      title: 'timer sweep',
      assignee_type: 'agent',
      assignee_id: host.agents[0]?.id,
    })
    await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
      token: host.hostToken,
      body: {},
    })
    const asked = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/questions', {
      token: host.hostToken,
      body: { question_text: 'tick' },
    })
    hub.sqlite.prepare('UPDATE questions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, asked.body.question.id)

    // When the timer interval elapses
    vi.useFakeTimers()
    try {
      const sweeper = createSweeper(hub.hub.env, { intervalMs: 1_000, log: () => undefined })
      sweeper.start()
      await vi.advanceTimersByTimeAsync(1_000)
      sweeper.stop()

      // Then the sweep ran from the interval and expired it
      const row = one<{ status: string }>(hub, 'SELECT status FROM questions WHERE id = ?', asked.body.question.id)
      expect(row?.status).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
})
