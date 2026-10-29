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
import { channelState } from '../src/channel'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

interface CommentFixture {
  env: Env
  teamId: string
  issueId: string
  memberToken: string
  adminToken: string
  hostToken: string
  otherHostToken: string
  agentId: string
  agentName: string
}

async function fixture(): Promise<CommentFixture> {
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
    token: adminToken,
    body: { platform: 'ios', device_token: 'device-admin', bundle_id: 'com.example.whale', environment: 'sandbox' },
  })
  const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
    token: memberToken,
    body: { title: 'Discuss the endpoint', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
  })
  return {
    env,
    teamId: team.teamId,
    issueId: created.body.issue.id as string,
    memberToken,
    adminToken,
    hostToken: hostA.hostToken,
    otherHostToken: hostB.hostToken,
    agentId: hostA.agents[0]?.id as string,
    agentName: hostA.agents[0]?.name as string,
  }
}

describe('comment submission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member posts a human comment that is stored and audited', async () => {
    // Given an issue in the team
    const context = await fixture()

    // When the member comments on it
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: 'Looks straightforward.' },
    })

    // Then the comment carries the human author and the audit row exists
    expect(created.status).toBe(201)
    expect(created.body.comment.author_type).toBe('human')
    const author = await one<{ id: string }>(context.env, 'SELECT id FROM members WHERE github_username = ?', 'hubot')
    expect(created.body.comment.author_member_id).toBe(author?.id)
    const activity = await all<{ activity_type: string }>(
      context.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      context.issueId,
    )
    expect(activity.map((row) => row.activity_type)).toContain('comment.created')
  })

  it('member is refused a comment over 32 KiB', async () => {
    // Given an issue in the team
    const context = await fixture()

    // When the comment text exceeds the byte cap
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: 'z'.repeat(32_769) },
    })

    // Then the request is refused with the limit named
    expect(created.status).toBe(400)
    expect(created.body.error.details.limit_bytes).toBe(32_768)
  })

  it('member is refused an empty comment', async () => {
    // Given an issue in the team
    const context = await fixture()

    // When the member posts nothing
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: '' },
    })

    // Then the validation fails
    expect(created.status).toBe(400)
    expect(created.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('host posts an agent comment that carries its agent identity', async () => {
    // Given an issue assigned to an agent of host A
    const context = await fixture()

    // When the host posts the agent comment
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.hostToken,
      body: { content: 'Starting the run.', author_type: 'agent', author_agent_id: context.agentId },
    })

    // Then the comment is attributed to that agent
    expect(created.status).toBe(201)
    expect(created.body.comment.author_type).toBe('agent')
    expect(created.body.comment.author_agent_id).toBe(context.agentId)
  })

  it('host is refused a comment without the agent author type', async () => {
    // Given a host token
    const context = await fixture()

    // When it posts without naming the agent author
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.hostToken,
      body: { content: 'no author type' },
    })

    // Then the role rule refuses it
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('FORBIDDEN')
  })

  it('host is refused a comment attributed to another host agent', async () => {
    // Given a host token and an agent belonging to another host
    const context = await fixture()
    const foreign = await one<{ id: string }>(
      context.env,
      'SELECT id FROM agents WHERE team_id = ? AND name = ?',
      context.teamId,
      'dev-bot',
    )

    // When it posts as that agent
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.hostToken,
      body: { content: 'impersonation', author_type: 'agent', author_agent_id: foreign?.id },
    })

    // Then the host binding refuses it
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('HOST_MISMATCH')
  })

  it('member is refused an agent authored comment', async () => {
    // Given a member session
    const context = await fixture()

    // When the member claims to be an agent
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: 'I am a bot', author_type: 'agent', author_agent_id: context.agentId },
    })

    // Then the role rule refuses it
    expect(created.status).toBe(403)
  })

  it('member reads the comment thread in creation order', async () => {
    // Given two comments posted one after the other
    const context = await fixture()
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: 'first' },
    })
    vi.setSystemTime(T0 + 1000)
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: 'second' },
    })

    // When the member reads the thread
    const listed = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
    })

    // Then both comments come back oldest first
    expect(listed.status).toBe(200)
    expect(listed.body.comments.map((comment: { content: string }) => comment.content)).toEqual(['first', 'second'])
  })
})

describe('mentions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member mention resolves to the teammate and pushes them', async () => {
    // Given an issue and a teammate with a registered device
    const context = await fixture()

    // When the member mentions the admin by GitHub username
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: '@octocat please look' },
    })

    // Then the mention row points at that member
    expect(created.status).toBe(201)
    const mentions = await all<{ target_type: string; target_member_id: string | null }>(
      context.env,
      'SELECT target_type, target_member_id FROM comment_mentions WHERE comment_id = ?',
      created.body.comment.id,
    )
    const admin = await one<{ id: string }>(context.env, 'SELECT id FROM members WHERE github_username = ?', 'octocat')
    expect(mentions).toHaveLength(1)
    expect(mentions[0]).toEqual({ target_type: 'member', target_member_id: admin?.id })
  })

  it('agent mention resolves to the agent and reaches its host channel', async () => {
    // Given an issue and a registered agent
    const context = await fixture()
    const before = await channelState(context.env, context.teamId)

    // When the member mentions the agent by name
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: '@' + context.agentName + ' take a look' },
    })

    // Then the mention targets the agent and a host targeted event was queued
    const mentions = await all<{ target_type: string; target_agent_id: string | null }>(
      context.env,
      'SELECT target_type, target_agent_id FROM comment_mentions WHERE target_type = ?',
      'agent',
    )
    expect(mentions[0]?.target_agent_id).toBe(context.agentId)
    const after = await channelState(context.env, context.teamId)
    expect((after.latest_seq ?? 0) - (before.latest_seq ?? 0)).toBe(2)
  })

  it('unknown mention handle does not create a mention row', async () => {
    // Given an issue in the team
    const context = await fixture()

    // When the member mentions a handle nobody owns
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: '@nobodyhere are you there?' },
    })

    // Then the comment exists without a mention row
    expect(created.status).toBe(201)
    const mentions = await all<{ comment_id: string }>(
      context.env,
      'SELECT comment_id FROM comment_mentions WHERE comment_id = ?',
      created.body.comment.id,
    )
    expect(mentions).toHaveLength(0)
  })

  it('two mentions in one comment produce two mention rows in one write', async () => {
    // Given an issue in the team
    const context = await fixture()

    // When the member mentions a human and an agent
    const created = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.memberToken,
      body: { content: '@octocat and @' + context.agentName + ' both' },
    })

    // Then both targets are recorded against the comment
    const mentions = await all<{ target_type: string }>(
      context.env,
      'SELECT target_type FROM comment_mentions WHERE comment_id = ? ORDER BY target_type',
      created.body.comment.id,
    )
    expect(mentions.map((row) => row.target_type)).toEqual(['agent', 'member'])
  })
})