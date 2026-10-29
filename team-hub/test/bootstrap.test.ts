import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  all,
  api,
  createEnv,
  externalTransport,
  one,
  seedTeam,
  T0,
  tokenFor,
  type GithubAccount,
  type MemberRow,
  type TestEnv,
} from './helpers'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: 'https://img/octo.png' }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }
/** The value an operator stores as the BOOTSTRAP_TOKEN secret. */
const BOOTSTRAP_TOKEN = 'boot-9f2c4a1b7d8e5f6031c2b4a6d8e0f1a3'
const BODY = { team_name: 'DSH Team', team_slug: 'team-dsh', github_username: 'octocat' }

function hubEnv(options: { bootstrapToken?: string } = {}): TestEnv {
  const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
  if (options.bootstrapToken === undefined) return env
  return { ...env, BOOTSTRAP_TOKEN: options.bootstrapToken }
}

function bootstrap(env: Env, body: Record<string, unknown> = BODY, token: string | null = BOOTSTRAP_TOKEN) {
  const headers: Record<string, string> = {}
  if (token !== null) headers['x-bootstrap-token'] = token
  return api(env, 'POST', '/api/v1/bootstrap', { headers, body })
}

describe('hub bootstrap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a hub without the bootstrap secret answers NOT_CONFIGURED', async () => {
    // Given a deployment where BOOTSTRAP_TOKEN was never stored as a secret
    const env = hubEnv()

    // When the endpoint is called with a token anyway
    const result = await bootstrap(env)

    // Then it is closed rather than left open, and nothing is written
    expect(result.status).toBe(503)
    expect(result.body.error.code).toBe('NOT_CONFIGURED')
    expect(await one(env, 'SELECT id FROM teams')).toBeNull()
  })

  it('a missing or wrong bootstrap token is refused', async () => {
    // Given a hub with the secret configured
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })

    // When the call arrives without the header, and then with a token that differs
    const missing = await bootstrap(env, BODY, null)
    const wrong = await bootstrap(env, BODY, BOOTSTRAP_TOKEN + '-other')

    // Then both are refused before anything is read from the body
    expect([missing.status, wrong.status]).toEqual([401, 401])
    expect([missing.body.error.code, wrong.body.error.code]).toEqual(['UNAUTHORIZED', 'UNAUTHORIZED'])
    expect(await one(env, 'SELECT id FROM teams')).toBeNull()
  })

  it('bootstrap creates the first team and its active admin', async () => {
    // Given a freshly deployed hub with no team yet
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })

    // When the operator bootstraps the first team
    const result = await bootstrap(env)

    // Then the response names the team and the admin the call created
    expect(result.status).toBe(201)
    expect(result.body.team).toMatchObject({ name: 'DSH Team', slug: 'team-dsh' })
    expect(result.body.member).toMatchObject({ github_username: 'octocat', role: 'admin' })

    // And both rows are stored, the membership active and bound to the numeric GitHub id
    const team = await one<{ name: string; slug: string }>(
      env,
      'SELECT name, slug FROM teams WHERE id = ?',
      result.body.team.id,
    )
    expect(team).toEqual({ name: 'DSH Team', slug: 'team-dsh' })
    const member = await one<MemberRow>(env, 'SELECT * FROM members WHERE id = ?', result.body.member.id)
    expect(member).toMatchObject({
      team_id: result.body.team.id,
      github_user_id: 1001,
      github_username: 'octocat',
      display_name: 'Octo Cat',
      role: 'admin',
      status: 'active',
    })
  })

  it('bootstrap reports a GitHub login that does not exist', async () => {
    // Given a hub that knows only the two GitHub accounts the fake serves
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })

    // When the operator bootstraps with an unknown login
    const result = await bootstrap(env, { ...BODY, github_username: 'ghost' })

    // Then the missing GitHub account is reported and no team is created
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('USER_NOT_FOUND')
    expect(await one(env, 'SELECT id FROM teams')).toBeNull()
  })

  it('the bootstrapped admin can mint a Host token', async () => {
    // Given the membership bootstrap created
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })
    const created = await bootstrap(env)
    const member = (await one<MemberRow>(env, 'SELECT * FROM members WHERE id = ?', created.body.member.id)) as MemberRow
    const token = await tokenFor(env, member)

    // When that member calls an endpoint only an admin may use
    const minted = await api(env, 'POST', '/api/v1/teams/' + created.body.team.id + '/hosts/tokens', {
      token,
      body: { hostname: 'macbook-pro' },
    })

    // Then the admin role the bootstrap wrote is what the hub enforces
    expect(minted.status).toBe(201)
    expect(minted.body.host_token).toMatch(/^th_host_[0-9a-f]{64}$/)
  })

  it('bootstrap closes itself after the first successful call', async () => {
    // Given a hub whose first team now exists
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })
    const created = await bootstrap(env)

    // When the same documented call is repeated
    const second = await bootstrap(env, { ...BODY, team_slug: 'team-other' })

    // Then the hub refuses a second team and keeps the one it has
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('CONFLICT')
    expect(second.body.error.details.team_id).toBe(created.body.team.id)
    const teams = await all<{ id: string }>(env, 'SELECT id FROM teams')
    expect(teams.map((row) => row.id)).toEqual([created.body.team.id])
  })

  it('two simultaneous bootstrap calls leave exactly one team', async () => {
    // Given a freshly deployed hub with no team yet
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })

    // When two calls arrive together
    const [first, second] = await Promise.all([bootstrap(env), bootstrap(env, { ...BODY, team_slug: 'team-second' })])

    // Then exactly one of them creates the team and the other is refused
    expect([first.status, second.status].sort()).toEqual([201, 409])

    // And the hub holds one team with its one admin, whichever call won
    const teams = await all<{ id: string }>(env, 'SELECT id FROM teams')
    expect(teams).toHaveLength(1)
    const members = await all<{ role: string; team_id: string }>(env, 'SELECT role, team_id FROM members')
    expect(members).toEqual([{ role: 'admin', team_id: teams[0]?.id }])
  })

  it('bootstrap is refused once the hub already has a team', async () => {
    // Given a hub whose teams table was filled by an earlier deployment
    const env = hubEnv({ bootstrapToken: BOOTSTRAP_TOKEN })
    const seeded = await seedTeam(env)

    // When the operator calls bootstrap on it
    const result = await bootstrap(env)

    // Then the existing team is reported as a conflict and the table is untouched
    expect(result.status).toBe(409)
    expect(result.body.error.code).toBe('CONFLICT')
    expect(result.body.error.details.team_id).toBe(seeded.teamId)
    expect(await all<{ id: string }>(env, 'SELECT id FROM teams')).toHaveLength(1)
  })
})
