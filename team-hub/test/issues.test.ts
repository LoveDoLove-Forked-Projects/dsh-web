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

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

async function fixture() {
  const outbound = externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } })
  const env = createEnv(outbound.transport)
  const team = await seedTeam(env)
  const adminToken = await tokenFor(env, team.admin)
  const memberToken = await tokenFor(env, team.member)
  return { env, outbound, team, adminToken, memberToken }
}

describe('issue creation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member creates an unassigned issue that starts in todo', async () => {
    // Given a member with a session
    const { env, team, memberToken } = await fixture()

    // When the member creates an issue without an assignee
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'Ship the hub', description: 'Phase 1' },
    })

    // Then it lands in todo with a per-team number and an audit row
    expect(created.status).toBe(201)
    expect(created.body.issue.status).toBe('todo')
    expect(created.body.issue.issue_number).toBe(1)
    expect(created.body.issue.creator_member_id).toBe(team.member.id)
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ?', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toEqual(['issue.created'])
  })

  it('member assigns a human issue and the assignee is notified', async () => {
    // Given a member session and an APNs-registered teammate
    const { env, outbound, team, memberToken } = await fixture()
    await api(env, 'POST', '/api/v1/push-tokens', {
      token: await tokenFor(env, team.admin),
      body: { platform: 'ios', device_token: 'device-admin', bundle_id: 'com.example.whale', environment: 'sandbox' },
    })

    // When the member assigns the new issue to the admin
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'Review the spec', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then it is assigned and a push is delivered to the assignee device
    expect(created.body.issue.status).toBe('assigned')
    const pushes = outbound.calls.filter((call) => call.url.includes('api.sandbox.push.apple.com'))
    expect(pushes).toHaveLength(1)
    const payload = JSON.parse(pushes[0]?.body ?? '{}')
    expect(payload.event_type).toBe('assigned')
    expect(payload.aps.alert.body).toBe('You were assigned to issue #1: Review the spec')
  })

  it('member assigns an agent issue and the creator becomes the default reviewer', async () => {
    // Given a team with an online Host and one agent
    const { env, team, memberToken } = await fixture()
    const host = await seedHost(env, team.teamId, await tokenFor(env, team.admin), {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const agent = host.agents[0]

    // When the member creates an issue for that agent without naming a reviewer
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'Run the suite', assignee_type: 'agent', assignee_id: agent?.id },
    })

    // Then it is assigned to the agent and the creator reviews it
    expect(created.status).toBe(201)
    expect(created.body.issue.status).toBe('assigned')
    expect(created.body.issue.assignee_agent_id).toBe(agent?.id)
    expect(created.body.issue.reviewer_member_id).toBe(team.member.id)
  })

  it('member sees an agent issue wait for its host while the host is offline', async () => {
    // Given a Host that never registered, so it is offline
    const { env, team, memberToken } = await fixture()
    const adminToken = await tokenFor(env, team.admin)
    const minted = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/tokens', {
      token: adminToken,
      body: { hostname: 'host-a' },
    })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/hosts/register', {
      token: minted.body.host_token as string,
      body: { hostname: 'host-a', client_version: '1.0.0', agents: [{ name: 'qa-bot', preset_id: 'liangshen' }] },
    })
    const agent = await one<{ id: string }>(env, 'SELECT id FROM agents WHERE team_id = ?', team.teamId)
    await env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE team_id = ?").bind(team.teamId).run()

    // When the member assigns an issue to that agent
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'Run the suite', assignee_type: 'agent', assignee_id: agent?.id },
    })

    // Then the issue waits for the execution node and says so in the audit log
    expect(created.body.issue.status).toBe('waiting_host')
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ?', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toEqual(['issue.created', 'issue.assigned', 'issue.waiting_host'])
  })

  it('member is refused an issue title over 256 characters', async () => {
    // Given a member session
    const { env, team, memberToken } = await fixture()

    // When the title exceeds the section 11 cap
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'x'.repeat(257) },
    })

    // Then the validation failure names the limit
    expect(created.status).toBe(400)
    expect(created.body.error.code).toBe('VALIDATION_FAILED')
    expect(created.body.error.details.limit_chars).toBe(256)
  })

  it('member is refused an issue description over 64 KiB', async () => {
    // Given a member session
    const { env, team, memberToken } = await fixture()

    // When the description exceeds the byte cap
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'ok', description: 'y'.repeat(65_537) },
    })

    // Then the request is refused
    expect(created.status).toBe(400)
    expect(created.body.error.details.limit_bytes).toBe(65_536)
  })

  it('member numbers issues inside the team', async () => {
    // Given two issues created in the same team
    const { env, team, memberToken } = await fixture()
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', { token: memberToken, body: { title: 'one' } })

    // When the second issue is created
    const second = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'two' },
    })

    // Then its number follows the first
    expect(second.body.issue.issue_number).toBe(2)
  })
})

describe('issue listing and editing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host only lists issues of its own agents', async () => {
    // Given two hosts on one team, each with one agent and one issue
    const { env, team, memberToken } = await fixture()
    const adminToken = await tokenFor(env, team.admin)
    const hostA = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const hostB = await seedHost(env, team.teamId, adminToken, {
      hostname: 'host-b',
      agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
    })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'for a', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
    })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'for b', assignee_type: 'agent', assignee_id: hostB.agents[0]?.id },
    })

    // When host A polls its queue with the status filter of section 5
    const listed = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/issues', {
      token: hostA.hostToken,
      query: { status: 'assigned,waiting_host' },
    })

    // Then it sees only its own issue
    expect(listed.status).toBe(200)
    expect(listed.body.issues.map((issue: { title: string }) => issue.title)).toEqual(['for a'])
  })

  it('member filters the issue list by comma separated status', async () => {
    // Given issues in two different statuses
    const { env, team, memberToken } = await fixture()
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', { token: memberToken, body: { title: 'todo one' } })
    await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'assigned one', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // When the member asks for assigned and waiting_host only
    const listed = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      query: { status: 'assigned,waiting_host' },
    })

    // Then only the assigned issue is returned
    expect(listed.body.issues.map((issue: { title: string }) => issue.title)).toEqual(['assigned one'])
  })

  it('member edits the title and receives the changed field list', async () => {
    // Given an existing issue
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'old title' },
    })

    // When the member renames it
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { title: 'new title' },
    })

    // Then the issue carries the new title
    expect(patched.status).toBe(200)
    expect(patched.body.issue.title).toBe('new title')
    const updated = await one<{ title: string }>(env, 'SELECT title FROM issues WHERE id = ?', created.body.issue.id)
    expect(updated?.title).toBe('new title')
  })

  it('member reassigns a todo issue to a teammate', async () => {
    // Given an unassigned issue
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'do it' },
    })

    // When the member assigns it to the admin
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { assignee_type: 'member', assignee_id: team.admin.id },
    })

    // Then the issue is assigned and the audit log records it
    expect(patched.body.issue.status).toBe('assigned')
    expect(patched.body.issue.assignee_member_id).toBe(team.admin.id)
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ? ORDER BY created_at', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toContain('issue.assigned')
  })

  it('member reads one issue by id with its collaboration state', async () => {
    // Given an issue assigned to the admin
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'read me', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // When the member reads that issue by id
    const fetched = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
    })

    // Then the issue comes back without any lease secret
    expect(fetched.status).toBe(200)
    expect(fetched.body.issue).toMatchObject({
      id: created.body.issue.id,
      title: 'read me',
      status: 'assigned',
      assignee_member_id: team.admin.id,
      has_lease: false,
    })
    expect(fetched.body.issue.lease_token).toBeUndefined()
  })

  it('member is told the issue does not exist', async () => {
    // Given a member session and no such issue
    const { env, team, memberToken } = await fixture()

    // When the member reads an unknown issue id
    const fetched = await api(env, 'GET', '/api/v1/teams/' + team.teamId + '/issues/issue_missing', {
      token: memberToken,
    })

    // Then the missing issue is reported as not found
    expect(fetched.status).toBe(404)
    expect(fetched.body.error.code).toBe('ISSUE_NOT_FOUND')
  })

  it('member is refused an issue of another team', async () => {
    // Given an issue in one team
    const { env, memberToken } = await fixture()
    const other = await seedTeam(env)
    const created = await api(env, 'POST', '/api/v1/teams/' + other.teamId + '/issues', {
      token: await tokenFor(env, other.admin),
      body: { title: 'other team issue' },
    })

    // When a member of the first team asks for it
    const fetched = await api(env, 'GET', '/api/v1/teams/' + other.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
    })

    // Then the request is refused before the issue is read
    expect(fetched.status).toBe(403)
    expect(fetched.body.error.code).toBe('FORBIDDEN')
  })
})

describe('human driven transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member submits an assigned member issue for review', async () => {
    // Given an issue assigned to the member with the admin as reviewer
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'needs review', assignee_type: 'member', assignee_id: team.member.id, reviewer_member_id: team.admin.id },
    })

    // When the assignee submits it for review
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'in_review' },
    })

    // Then it waits for the human reviewer
    expect(patched.status).toBe(200)
    expect(patched.body.issue.status).toBe('in_review')
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ?', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toContain('issue.submitted_for_review')
  })

  it('member is refused submission for review without a reviewer', async () => {
    // Given an assigned member issue with no reviewer
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'no reviewer', assignee_type: 'member', assignee_id: team.admin.id },
    })

    // When the member submits it for review anyway
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'in_review' },
    })

    // Then the transition is refused
    expect(patched.status).toBe(422)
    expect(patched.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('member completes a member issue that has no reviewer', async () => {
    // Given an issue assigned to the member with no reviewer
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'direct done', assignee_type: 'member', assignee_id: team.member.id },
    })

    // When the assignee marks it done
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'done' },
    })

    // Then it is done and the audit trail says completed
    expect(patched.body.issue.status).toBe('done')
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ?', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toContain('issue.completed')
  })

  it('member who is not the assignee is refused submission for review', async () => {
    // Given an issue assigned to the admin with a reviewer
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: {
        title: 'someone else card',
        assignee_type: 'member',
        assignee_id: team.admin.id,
        reviewer_member_id: team.admin.id,
      },
    })

    // When a member who is neither the assignee nor an admin submits it
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'in_review' },
    })

    // Then the transition is forbidden for them
    expect(patched.status).toBe(403)
    expect(patched.body.error.code).toBe('FORBIDDEN')
  })

  it('member is refused direct completion when a reviewer is set', async () => {
    // Given an assigned issue that carries a reviewer
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'reviewed', assignee_type: 'member', assignee_id: team.admin.id, reviewer_member_id: team.member.id },
    })

    // When the assignee tries to skip the review
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'done' },
    })

    // Then the transition is refused
    expect(patched.status).toBe(422)
  })

  it('member cancels an active issue and the cancel is audited', async () => {
    // Given an unassigned issue
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'cancel me' },
    })

    // When the member cancels it
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'canceled' },
    })

    // Then it is canceled and a second cancel is refused
    expect(patched.body.issue.status).toBe('canceled')
    const again = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'canceled' },
    })
    expect(again.status).toBe(422)
    const activity = await all<{ activity_type: string }>(env, 'SELECT activity_type FROM activity WHERE issue_id = ?', created.body.issue.id)
    expect(activity.map((row) => row.activity_type)).toContain('issue.canceled')
  })

  it('member is refused a transition the matrix does not allow', async () => {
    // Given a todo issue
    const { env, team, memberToken } = await fixture()
    const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
      token: memberToken,
      body: { title: 'todo issue' },
    })

    // When the member tries to move it straight to running
    const patched = await api(env, 'PATCH', '/api/v1/teams/' + team.teamId + '/issues/' + created.body.issue.id, {
      token: memberToken,
      body: { status: 'running' },
    })

    // Then the transition is refused
    expect(patched.status).toBe(422)
    expect(patched.body.error.details.status).toBe('running')
  })
})