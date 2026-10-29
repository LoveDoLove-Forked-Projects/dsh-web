import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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

interface InboxFixture {
  env: Env
  teamId: string
  memberToken: string
  adminToken: string
  adminId: string
  memberId: string
  hostToken: string
  hostId: string
  agentId: string
}

async function fixture(): Promise<InboxFixture> {
  const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
  const team = await seedTeam(env)
  const adminToken = await tokenFor(env, team.admin)
  const memberToken = await tokenFor(env, team.member)
  const host = await seedHost(env, team.teamId, adminToken, {
    hostname: 'host-a',
    agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
  })
  return {
    env,
    teamId: team.teamId,
    memberToken,
    adminToken,
    adminId: team.admin.id,
    memberId: team.member.id,
    hostToken: host.hostToken,
    hostId: host.hostId,
    agentId: host.agents[0]?.id as string,
  }
}

describe('inbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member sees assigned issues, review requests, questions and unread mentions', async () => {
    // Given a member with one assigned issue, one issue awaiting their review,
    // a pending question they receive and one unread mention
    const context = await fixture()
    const assigned = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.adminToken,
      body: { title: 'assigned to member', assignee_type: 'member', assignee_id: context.memberId },
    })
    const reviewable = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.memberToken,
      body: {
        title: 'review me',
        assignee_type: 'member',
        assignee_id: context.adminId,
        reviewer_member_id: context.memberId,
      },
    })
    await api(context.env, 'PATCH', '/api/v1/teams/' + context.teamId + '/issues/' + reviewable.body.issue.id, {
      token: context.adminToken,
      body: { status: 'in_review' },
    })
    const agentIssue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.memberToken,
      body: { title: 'agent card', assignee_type: 'agent', assignee_id: context.agentId },
    })
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + agentIssue.body.issue.id + '/claim', {
      token: context.hostToken,
      body: {},
    })
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + agentIssue.body.issue.id + '/questions', {
      token: context.hostToken,
      body: { question_text: 'which endpoint?' },
    })
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + assigned.body.issue.id + '/comments', {
      token: context.adminToken,
      body: { content: '@hubot have a look' },
    })

    // When the member opens the inbox
    const inbox = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/inbox', {
      token: context.memberToken,
    })

    // Then each section holds exactly what waits on that member
    expect(inbox.status).toBe(200)
    expect(inbox.body.assigned.map((issue: { title: string }) => issue.title)).toEqual(['assigned to member'])
    expect(inbox.body.review.map((issue: { title: string }) => issue.title)).toEqual(['review me'])
    expect(inbox.body.questions.map((question: { question_text: string }) => question.question_text)).toEqual([
      'which endpoint?',
    ])
    expect(inbox.body.mentions).toHaveLength(1)
    expect(inbox.body.mentions[0].issue_id).toBe(assigned.body.issue.id)
  })

  it('member marks a mention read and it leaves the inbox', async () => {
    // Given an unread mention
    const context = await fixture()
    const issue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.adminToken,
      body: { title: 'mention card' },
    })
    const comment = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/comments',
      { token: context.adminToken, body: { content: '@hubot ping' } },
    )

    // When the member marks that mention read
    const read = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/inbox/mentions/' + comment.body.comment.id + '/read',
      { token: context.memberToken },
    )

    // Then the inbox no longer lists it
    expect(read.status).toBe(200)
    const inbox = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/inbox', {
      token: context.memberToken,
    })
    expect(inbox.body.mentions).toHaveLength(0)
    const stored = await one<{ read_at: number | null }>(
      context.env,
      'SELECT read_at FROM comment_mentions WHERE comment_id = ?',
      comment.body.comment.id,
    )
    expect(stored?.read_at).toBe(T0)
  })

  it('member does not see finished issues in the assigned section', async () => {
    // Given an issue assigned to the member and already canceled
    const context = await fixture()
    const issue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.adminToken,
      body: { title: 'dropped', assignee_type: 'member', assignee_id: context.memberId },
    })
    await api(context.env, 'PATCH', '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id, {
      token: context.memberToken,
      body: { status: 'canceled' },
    })

    // When the member opens the inbox
    const inbox = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/inbox', {
      token: context.memberToken,
    })

    // Then the canceled issue is gone
    expect(inbox.body.assigned).toHaveLength(0)
  })

  it('host is refused the inbox endpoint', async () => {
    // Given a registered Host token
    const context = await fixture()

    // When the Host asks for the inbox
    const inbox = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/inbox', {
      token: context.hostToken,
    })

    // Then the role matrix refuses it
    expect(inbox.status).toBe(403)
    expect(inbox.body.error.code).toBe('FORBIDDEN')
  })
})

describe('activity feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member pages the activity of one issue with a cursor', async () => {
    // Given an issue with four audit rows from four comments
    const context = await fixture()
    const issue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.memberToken,
      body: { title: 'audited' },
    })
    for (let index = 0; index < 4; index += 1) {
      vi.setSystemTime(T0 + (index + 1) * 1000)
      await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/comments', {
        token: context.memberToken,
        body: { content: 'note ' + index },
      })
    }

    // When the member reads the first page of two entries
    const first = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/activity',
      { token: context.memberToken, query: { limit: '2' } },
    )

    // Then two newest entries come back with a cursor for the rest
    expect(first.status).toBe(200)
    expect(first.body.activity).toHaveLength(2)
    expect(typeof first.body.next_cursor).toBe('string')

    // When the member reads the next page with that cursor
    const second = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/activity',
      { token: context.memberToken, query: { limit: '2', before: first.body.next_cursor } },
    )

    // Then the older entries follow without repeating the first page
    const firstIds = first.body.activity.map((row: { id: string }) => row.id)
    const secondIds = second.body.activity.map((row: { id: string }) => row.id)
    expect(secondIds).toHaveLength(2)
    expect(second.body.activity.every((row: { activity_type: string }) => row.activity_type === 'comment.created')).toBe(true)
    const firstIdSet = new Set(firstIds)
    expect(secondIds.some((id: string) => firstIdSet.has(id))).toBe(false)
  })

  it('member is refused an activity limit outside one to one hundred', async () => {
    // Given an issue
    const context = await fixture()
    const issue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.memberToken,
      body: { title: 'limits' },
    })

    // When the member asks for 101 entries
    const listed = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/activity',
      { token: context.memberToken, query: { limit: '101' } },
    )

    // Then the request is refused
    expect(listed.status).toBe(400)
    expect(listed.body.error.details.max).toBe(100)
  })

  it('host is refused the activity feed', async () => {
    // Given an issue and a host token
    const context = await fixture()
    const issue = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.memberToken,
      body: { title: 'host cannot read this' },
    })

    // When the host asks for the activity feed
    const listed = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.teamId + '/issues/' + issue.body.issue.id + '/activity',
      { token: context.hostToken },
    )

    // Then the role matrix refuses it
    expect(listed.status).toBe(403)
    expect(listed.body.error.code).toBe('FORBIDDEN')
  })

  it('member is refused the identity endpoint with a host token', async () => {
    // Given a host token
    const context = await fixture()

    // When the host asks who it is
    const me = await api(context.env, 'GET', '/api/v1/me', { token: context.hostToken })

    // Then only members may call it
    expect(me.status).toBe(403)
    expect(me.body.error.code).toBe('FORBIDDEN')
  })
})