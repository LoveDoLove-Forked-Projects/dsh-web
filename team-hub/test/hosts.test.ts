import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { all, api, createEnv, externalTransport, one, seedHost, seedTeam, T0, tokenFor, type GithubAccount } from './helpers'
import { sweepAllTeams } from '../src/domain/sweep'
import { HOST_OFFLINE_THRESHOLD_MS } from '../src/constants'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

describe('host registration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host registers and its agent definitions are synchronised', async () => {
    // Given an admin session for a team
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)

    // When the Host registers with two agents
    const host = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [
        { name: 'qa-bot', preset_id: 'liangshen' },
        { name: 'review-bot', preset_id: 'reviewer' },
      ],
    })

    // Then the host is online and both agents are idle on it
    const stored = await one<{ status: string; hostname: string; client_version: string }>(
      env,
      'SELECT status, hostname, client_version FROM hosts WHERE id = ?',
      host.hostId,
    )
    expect(stored).toEqual({ status: 'online', hostname: 'host-a', client_version: '1.0.0' })
    expect(host.agents.map((agent) => agent.name)).toEqual(['qa-bot', 'review-bot'])
    expect(host.agents.every((agent) => agent.status === 'idle' && agent.host_id === host.hostId)).toBe(true)
  })

  it('host registration answers with the hub agent ids and stores the binding', async () => {
    // Given an admin session and a Host that reports a model and an effort
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const minted = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token: adminToken,
      body: { hostname: 'host-a' },
    })

    // When the Host registers with its agent definitions
    const registered = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: minted.body.host_token as string,
      body: {
        hostname: 'host-a',
        client_version: '0.2.1-rc.3',
        agents: [
          { name: 'qa-bot', preset_id: 'liangshen', model: 'deepseek/deepseek-v4', reasoning_effort: 'high' },
          { name: 'review-bot', preset_id: 'reviewer' },
        ],
      },
    })

    // Then the response maps every name to a hub agent id and the row keeps the binding
    expect(registered.status).toBe(200)
    expect(registered.body).toEqual({
      host_id: minted.body.host_id,
      status: 'online',
      agents: [
        { id: expect.any(String), name: 'qa-bot' },
        { id: expect.any(String), name: 'review-bot' },
      ],
      conflicts: [],
    })
    const stored = await all<{ name: string; preset_id: string; model: string | null; reasoning_effort: string | null }>(
      env,
      'SELECT name, preset_id, model, reasoning_effort FROM agents WHERE host_id = ? ORDER BY name',
      minted.body.host_id,
    )
    expect(stored).toEqual([
      { name: 'qa-bot', preset_id: 'liangshen', model: 'deepseek/deepseek-v4', reasoning_effort: 'high' },
      { name: 'review-bot', preset_id: 'reviewer', model: null, reasoning_effort: null },
    ])
  })

  it('host is refused an agent definition without a preset', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const host = await seedHost(env, team.teamId, await tokenFor(env, team.admin), { hostname: 'host-a', agents: [] })

    // When it reports an agent with an empty preset
    const registered = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: host.hostToken,
      body: { hostname: 'host-a', client_version: '1.0.0', agents: [{ name: 'ghost-bot', preset_id: '' }] },
    })

    // Then the definition is refused
    expect(registered.status).toBe(400)
    expect(registered.body.error.code).toBe('VALIDATION_FAILED')
    expect(registered.body.error.details.field).toBe('agents')
  })

  it('host re-registration updates an agent and retires one it no longer advertises', async () => {
    // Given a registered Host with two agents
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [
        { name: 'qa-bot', preset_id: 'liangshen' },
        { name: 'review-bot', preset_id: 'reviewer' },
      ],
    })

    // When it registers again advertising one agent with a new preset
    const again = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: host.hostToken,
      body: {
        hostname: 'host-a',
        client_version: '1.1.0',
        agents: [{ name: 'qa-bot', preset_id: 'liangshen-v2' }],
      },
    })

    // Then the advertised agent is updated and the other is marked offline
    expect(again.status).toBe(200)
    const agents = await all<{ name: string; status: string; preset_id: string }>(
      env,
      'SELECT name, status, preset_id FROM agents WHERE host_id = ? ORDER BY name',
      host.hostId,
    )
    expect(agents).toEqual([
      { name: 'qa-bot', status: 'idle', preset_id: 'liangshen-v2' },
      { name: 'review-bot', status: 'offline', preset_id: 'reviewer' },
    ])
  })

  it('host registration skips an agent name another host owns and reports the conflict', async () => {
    // Given host A owning qa-bot
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const hostA = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const minted = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token: adminToken,
      body: { hostname: 'host-b' },
    })

    // When host B registers with the clashing name plus a name of its own
    const registered = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: minted.body.host_token as string,
      body: {
        hostname: 'host-b',
        client_version: '1.0.0',
        agents: [
          { name: 'qa-bot', preset_id: 'other' },
          { name: 'dev-bot', preset_id: 'liangshen' },
        ],
      },
    })

    // Then the registration succeeds, the clash is reported and the other agent lands
    expect(registered.status).toBe(200)
    expect(registered.body.status).toBe('online')
    expect(registered.body.agents).toEqual([{ id: expect.any(String), name: 'dev-bot' }])
    expect(registered.body.conflicts).toEqual([
      { name: 'qa-bot', reason: 'agent name already belongs to another host' },
    ])
    const stored = await all<{ name: string; host_id: string }>(
      env,
      'SELECT name, host_id FROM agents WHERE team_id = ? ORDER BY name',
      team.teamId,
    )
    expect(stored).toEqual([
      { name: 'dev-bot', host_id: minted.body.host_id },
      { name: 'qa-bot', host_id: hostA.hostId },
    ])
    const online = await one<{ status: string }>(env, 'SELECT status FROM hosts WHERE id = ?', minted.body.host_id)
    expect(online?.status).toBe('online')
  })

  it('host heartbeat reports server time and keeps the host online', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When it heartbeats one interval later
    vi.setSystemTime(T0 + 15_000)
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/' + host.hostId + '/heartbeat', {
      token: host.hostToken,
    })

    // Then the response carries the server clock and the row advanced
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, server_time: T0 + 15_000 })
    const stored = await one<{ last_heartbeat_at: number; status: string }>(
      env,
      'SELECT last_heartbeat_at, status FROM hosts WHERE id = ?',
      host.hostId,
    )
    expect(stored).toEqual({ last_heartbeat_at: T0 + 15_000, status: 'online' })
  })

  it('host is refused a heartbeat for another host id', async () => {
    // Given a registered Host
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When it heartbeats under a different host id in the path
    const result = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/host_other/heartbeat', {
      token: host.hostToken,
    })

    // Then the mismatch is reported
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('HOST_MISMATCH')
  })

  it('host token of one team is refused on another team path', async () => {
    // Given two teams and a Host registered on the first
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const first = await seedTeam(env)
    const second = await seedTeam(env)
    const adminToken = await tokenFor(env, first.admin)
    const host = await seedHost(env, first.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When that Host heartbeats against the second team
    const result = await api(env, 'POST', '/api/v1/teams/' + second.teamId + '/hosts/' + host.hostId + '/heartbeat', {
      token: host.hostToken,
    })

    // Then the team mismatch is reported
    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('HOST_MISMATCH')
  })

  it('operator sees the host go offline only after three missed heartbeats', async () => {
    // Given a registered Host that last heartbeated at the current instant
    const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
    const team = await seedTeam(env)
    const adminToken = await tokenFor(env, team.admin)
    const host = await seedHost(env, team.teamId, adminToken, { hostname: 'host-a', agents: [] })

    // When the sweep runs one millisecond before the threshold
    await sweepAllTeams(env, T0 + HOST_OFFLINE_THRESHOLD_MS)
    const stillOnline = await one<{ status: string }>(env, 'SELECT status FROM hosts WHERE id = ?', host.hostId)

    // Then the Host is still online, and it goes offline one millisecond later
    expect(stillOnline?.status).toBe('online')
    await sweepAllTeams(env, T0 + HOST_OFFLINE_THRESHOLD_MS + 1)
    const offline = await one<{ status: string }>(env, 'SELECT status FROM hosts WHERE id = ?', host.hostId)
    expect(offline?.status).toBe('offline')
  })
})