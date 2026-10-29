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
  type MemberRow,
} from './helpers'
import { QUESTION_TTL_MS } from '../src/constants'
import { sweepAllTeams } from '../src/domain/sweep'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

interface QuestionFixture {
  env: Env
  teamId: string
  issueId: string
  hostToken: string
  hostId: string
  otherHostToken: string
  reviewerToken: string
  adminToken: string
  memberToken: string
  memberId: string
}

/** A running agent issue owned by the member, with two hosts available. */
async function runningIssue(): Promise<QuestionFixture> {
  const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
  const team = await seedTeam(env)
  const adminToken = await tokenFor(env, team.admin)
  const reviewerToken = await tokenFor(env, team.member)
  const hostA = await seedHost(env, team.teamId, adminToken, {
    hostname: 'host-a',
    agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
  })
  const hostB = await seedHost(env, team.teamId, adminToken, {
    hostname: 'host-b',
    agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
  })
  await api(env, 'POST', '/api/v1/push-tokens', {
    token: reviewerToken,
    body: { platform: 'ios', device_token: 'device-reviewer', bundle_id: 'com.example.whale', environment: 'sandbox' },
  })
  const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
    token: reviewerToken,
    body: { title: 'Confirm the endpoint', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
  })
  const issueId = created.body.issue.id as string
  await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
    token: hostA.hostToken,
    body: {},
  })
  return {
    env,
    teamId: team.teamId,
    issueId,
    hostToken: hostA.hostToken,
    hostId: hostA.hostId,
    otherHostToken: hostB.hostToken,
    reviewerToken,
    adminToken,
    memberToken: reviewerToken,
    memberId: team.member.id,
  }
}

function questionsPath(teamId: string, issueId: string): string {
  return '/api/v1/teams/' + teamId + '/issues/' + issueId + '/questions'
}

describe('question creation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host asks a question on a running issue and the reviewer is pushed', async () => {
    // Given a running agent issue whose reviewer registered a device
    const fixture = await runningIssue()

    // When the host submits the agent question
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: {
        question_text: 'Confirm the API endpoint',
        options: [{ label: 'yes' }, { label: 'no', description: 'ship as is' }],
        multi_select: false,
      },
    })

    // Then the question is pending for one day and a push went to the reviewer
    expect(created.status).toBe(201)
    expect(created.body.question.status).toBe('pending')
    const window = await one<{ expires_at: number }>(
      fixture.env,
      'SELECT expires_at FROM questions WHERE id = ?',
      created.body.question.id,
    )
    expect(window?.expires_at).toBe(T0 + QUESTION_TTL_MS)
    expect(created.body.question.options).toEqual([{ label: 'yes' }, { label: 'no', description: 'ship as is' }])
    const outbound = await all<{ activity_type: string }>(
      fixture.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      fixture.issueId,
    )
    expect(outbound.map((row) => row.activity_type)).toContain('question.created')
    const stored = await one<{ status: string }>(fixture.env, 'SELECT status FROM questions WHERE id = ?', created.body.question.id)
    expect(stored?.status).toBe('pending')
  })

  it('host is refused a question for an issue that is not running', async () => {
    // Given an agent issue that is only assigned
    const fixture = await runningIssue()
    await fixture.env.DB.prepare("UPDATE issues SET status = 'assigned' WHERE id = ?").bind(fixture.issueId).run()

    // When the host asks anyway
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'anyone there?' },
    })

    // Then the state machine refuses the question
    expect(created.status).toBe(422)
    expect(created.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('host is refused a question on another host agent issue', async () => {
    // Given a running issue owned by host A
    const fixture = await runningIssue()

    // When host B submits a question for it
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.otherHostToken,
      body: { question_text: 'not my card' },
    })

    // Then the host binding refuses it
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('HOST_MISMATCH')
  })

  it('member is refused question submission because only hosts ask', async () => {
    // Given a running issue and a member session
    const fixture = await runningIssue()

    // When the member submits a question
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.memberToken,
      body: { question_text: 'can I ask?' },
    })

    // Then the role matrix refuses it
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('FORBIDDEN')
  })
})

describe('answering a question', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reviewer answers the question and becomes the first responder', async () => {
    // Given a pending question
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'Confirm the endpoint', options: [{ label: 'yes' }, { label: 'no' }] },
    })

    // When the reviewer answers it
    const answered = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: fixture.reviewerToken, body: { selected: ['yes'] } },
    )

    // Then the answer is stored with the responder and the timestamp
    expect(answered.status).toBe(200)
    const stored = await one<{
      status: string
      first_responder_member_id: string
      answered_at: number
      answer_json: string
    }>(
      fixture.env,
      'SELECT status, first_responder_member_id, answered_at, answer_json FROM questions WHERE id = ?',
      created.body.question.id,
    )
    expect(stored?.status).toBe('answered')
    expect(stored?.first_responder_member_id).toBe(fixture.memberId)
    expect(stored?.answered_at).toBe(T0)
    expect(JSON.parse(stored?.answer_json ?? '{}')).toEqual({ selected: ['yes'] })
  })

  it('second responder is refused because the first answer wins', async () => {
    // Given a pending question
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'Confirm the endpoint' },
    })

    // When two members answer, the second one after the first
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/answer', {
      token: fixture.adminToken,
      body: { custom: 'first' },
    })
    const second = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: fixture.reviewerToken, body: { custom: 'second' } },
    )

    // Then the competing answer is a conflict and the first answer stands
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('QUESTION_ALREADY_ANSWERED')
    const stored = await one<{ first_responder_member_id: string; answer_json: string }>(
      fixture.env,
      'SELECT first_responder_member_id, answer_json FROM questions WHERE id = ?',
      created.body.question.id,
    )
    expect(JSON.parse(stored?.answer_json ?? '{}')).toEqual({ selected: [], custom: 'first' })
  })

  it('member is refused an answer to a question that expired', async () => {
    // Given a question whose 24 hour window closed and was swept
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'still there?' },
    })
    vi.setSystemTime(T0 + QUESTION_TTL_MS + 1)
    await sweepAllTeams(fixture.env, T0 + QUESTION_TTL_MS + 1)

    // When a member with a session issued after the sweep answers it
    const memberRow = await one<MemberRow>(fixture.env, 'SELECT * FROM members WHERE id = ?', fixture.memberId)
    const freshToken = await tokenFor(fixture.env, memberRow as MemberRow, T0 + QUESTION_TTL_MS + 1)
    const answered = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: freshToken, body: { custom: 'late' } },
    )

    // Then the question is no longer answerable
    expect(answered.status).toBe(409)
    expect(answered.body.error.code).toBe('QUESTION_NOT_PENDING')
  })
})

describe('question termination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host withdraws its own pending question and clients are told to dismiss it', async () => {
    // Given a pending question asked by host A
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'never mind' },
    })

    // When the host withdraws it
    const withdrawn = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/withdraw',
      { token: fixture.hostToken },
    )

    // Then it is dismissed and the withdrawal is audited
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body).toEqual({ ok: true, status: 'dismissed' })
    const stored = await one<{ status: string }>(fixture.env, 'SELECT status FROM questions WHERE id = ?', created.body.question.id)
    expect(stored?.status).toBe('dismissed')
    const activity = await all<{ activity_type: string }>(
      fixture.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      fixture.issueId,
    )
    expect(activity.map((row) => row.activity_type)).toContain('question.withdrawn')
  })

  it('host is refused the withdrawal of another host question', async () => {
    // Given a pending question asked by host A
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'never mind' },
    })

    // When host B tries to withdraw it
    const withdrawn = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/withdraw',
      { token: fixture.otherHostToken },
    )

    // Then the host mismatch is reported
    expect(withdrawn.status).toBe(403)
    expect(withdrawn.body.error.code).toBe('HOST_MISMATCH')
  })

  it('admin withdraws a pending question while a plain member cannot', async () => {
    // Given a pending question
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'who decides?' },
    })

    // When a plain member tries and then the admin does
    const byMember = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/withdraw',
      { token: fixture.reviewerToken },
    )
    const byAdmin = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/questions/' + created.body.question.id + '/withdraw',
      { token: fixture.adminToken },
    )

    // Then only the admin withdrawal is accepted
    expect(byMember.status).toBe(403)
    expect(byAdmin.status).toBe(200)
  })

  it('operator sees a pending question expire after its 24 hour window', async () => {
    // Given a pending question
    const fixture = await runningIssue()
    const created = await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'tick tock' },
    })

    // When the sweep runs one millisecond after the TTL
    await sweepAllTeams(fixture.env, T0 + QUESTION_TTL_MS + 1)

    // Then the question is expired and the expiry is audited
    const stored = await one<{ status: string }>(fixture.env, 'SELECT status FROM questions WHERE id = ?', created.body.question.id)
    expect(stored?.status).toBe('expired')
    const activity = await all<{ activity_type: string }>(
      fixture.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      fixture.issueId,
    )
    expect(activity.map((row) => row.activity_type)).toContain('question.expired')
  })
})

describe('question listing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member lists pending questions and filters by issue', async () => {
    // Given two pending questions on two issues
    const fixture = await runningIssue()
    await api(fixture.env, 'POST', questionsPath(fixture.teamId, fixture.issueId), {
      token: fixture.hostToken,
      body: { question_text: 'first question' },
    })
    const second = await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues', {
      token: fixture.reviewerToken,
      body: { title: 'another card', assignee_type: 'agent', assignee_id: (await one<{ id: string }>(fixture.env, 'SELECT id FROM agents WHERE host_id = ?', fixture.hostId))?.id },
    })
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + second.body.issue.id + '/claim', {
      token: fixture.hostToken,
      body: {},
    })
    await api(fixture.env, 'POST', questionsPath(fixture.teamId, second.body.issue.id), {
      token: fixture.hostToken,
      body: { question_text: 'second question' },
    })

    // When the member lists pending questions for the first issue only
    const listed = await api(fixture.env, 'GET', '/api/v1/teams/' + fixture.teamId + '/questions', {
      token: fixture.reviewerToken,
      query: { status: 'pending', issue_id: fixture.issueId },
    })

    // Then only that issue's question comes back
    expect(listed.status).toBe(200)
    expect(listed.body.questions).toHaveLength(1)
    expect(listed.body.questions[0].text).toBe('first question')
  })

  it('host is refused the team question list', async () => {
    // Given a running issue and its host
    const fixture = await runningIssue()

    // When the host asks for the team question list
    const listed = await api(fixture.env, 'GET', '/api/v1/teams/' + fixture.teamId + '/questions', {
      token: fixture.hostToken,
    })

    // Then the role matrix refuses a Host token here
    expect(listed.status).toBe(403)
    expect(listed.body.error.code).toBe('FORBIDDEN')
  })
})