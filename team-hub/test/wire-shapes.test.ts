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

const QUESTION_KEYS = [
  'answer',
  'answered_at',
  'created_at',
  'first_responder_member_id',
  'id',
  'issue_id',
  'multi_select',
  'options',
  'status',
  'text',
]

const ACTIVITY_KEYS = ['activity_type', 'actor_id', 'actor_type', 'created_at', 'id', 'issue_id', 'payload']

async function fixture() {
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
    body: { title: 'shape check', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
  })
  const issueId = created.body.issue.id as string
  await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
    token: hostA.hostToken,
    body: {},
  })
  return { env, team, adminToken, memberToken, hostA, hostB, issueId }
}

describe('agents roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member lists every agent with the liveness of its own host', async () => {
    // Given two hosts with one agent each, and the second host offline
    const context = await fixture()
    await context.env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").bind(context.hostB.hostId).run()

    // When the member reads the agent roster
    const listed = await api(context.env, 'GET', '/api/v1/teams/' + context.team.teamId + '/agents', {
      token: context.memberToken,
    })

    // Then each agent reports its binding and the host status the wire allows
    expect(listed.status).toBe(200)
    expect(listed.body.agents).toEqual([
      {
        id: context.hostB.agents[0]?.id,
        name: 'dev-bot',
        host_id: context.hostB.hostId,
        owner_member_id: context.team.admin.id,
        host_status: 'offline',
      },
      {
        id: context.hostA.agents[0]?.id,
        name: 'qa-bot',
        host_id: context.hostA.hostId,
        owner_member_id: context.team.admin.id,
        host_status: 'online',
      },
    ])
  })

  it('member sees a revoked host as offline on the agent roster', async () => {
    // Given a host whose token was revoked
    const context = await fixture()
    await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/hosts/' + context.hostB.hostId + '/revoke-token',
      { token: context.adminToken },
    )

    // When the member reads the roster
    const listed = await api(context.env, 'GET', '/api/v1/teams/' + context.team.teamId + '/agents', {
      token: context.adminToken,
    })

    // Then the revoked host is reported as offline, never as a third state
    const revoked = listed.body.agents.find((agent: { name: string }) => agent.name === 'dev-bot')
    expect(revoked.host_status).toBe('offline')
  })

  it('host is refused the agent roster', async () => {
    // Given a registered host
    const context = await fixture()

    // When the Host token asks for the roster
    const listed = await api(context.env, 'GET', '/api/v1/teams/' + context.team.teamId + '/agents', {
      token: context.hostA.hostToken,
    })

    // Then the role matrix refuses it
    expect(listed.status).toBe(403)
    expect(listed.body.error.code).toBe('FORBIDDEN')
  })
})

describe('question wire shape', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member receives the A2 shape with object options and a null answer while pending', async () => {
    // Given a running card on host A
    const context = await fixture()

    // When the host asks a question with labelled options
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      {
        token: context.hostA.hostToken,
        body: {
          question_text: 'Which endpoint should ship?',
          options: [{ label: 'v1', description: 'stable' }, { label: 'v2' }],
          multi_select: true,
        },
      },
    )

    // Then the question exposes exactly the supplement A2 fields
    expect(created.status).toBe(201)
    expect(Object.keys(created.body.question).sort()).toEqual(QUESTION_KEYS)
    expect(created.body.question).toMatchObject({
      issue_id: context.issueId,
      text: 'Which endpoint should ship?',
      options: [{ label: 'v1', description: 'stable' }, { label: 'v2' }],
      multi_select: true,
      status: 'pending',
      answer: null,
      first_responder_member_id: null,
      answered_at: null,
      created_at: T0,
    })
  })

  it('member answers with the A2 answer object and reads it back', async () => {
    // Given a pending question
    const context = await fixture()
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      {
        token: context.hostA.hostToken,
        body: { question_text: 'Pick one', options: [{ label: 'a' }, { label: 'b' }], multi_select: true },
      },
    )

    // When the reviewer answers with selected options plus a custom note
    const answered = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: context.memberToken, body: { selected: ['a', 'b'], custom: 'either is fine' } },
    )

    // Then the stored JSON and the wire answer are both objects
    expect(answered.status).toBe(200)
    const stored = await one<{ answer_json: string }>(
      context.env,
      'SELECT answer_json FROM questions WHERE id = ?',
      created.body.question.id,
    )
    expect(JSON.parse(stored?.answer_json ?? '{}')).toEqual({ selected: ['a', 'b'], custom: 'either is fine' })
    const listed = await api(context.env, 'GET', '/api/v1/teams/' + context.team.teamId + '/questions', {
      token: context.memberToken,
      query: { status: 'answered' },
    })
    expect(listed.body.questions[0]).toMatchObject({
      status: 'answered',
      answer: { selected: ['a', 'b'], custom: 'either is fine' },
      first_responder_member_id: context.team.member.id,
      answered_at: T0,
    })
    expect(Object.keys(listed.body.questions[0]).sort()).toEqual(QUESTION_KEYS)
  })

  it('member is refused an answer that carries neither a selection nor a custom text', async () => {
    // Given a pending question
    const context = await fixture()
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      { token: context.hostA.hostToken, body: { question_text: 'Anything?' } },
    )

    // When the member posts an empty answer object
    const answered = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: context.memberToken, body: { selected: [] } },
    )

    // Then the request is refused and the question stays pending
    expect(answered.status).toBe(400)
    expect(answered.body.error.code).toBe('VALIDATION_FAILED')
    const stored = await one<{ status: string }>(
      context.env,
      'SELECT status FROM questions WHERE id = ?',
      created.body.question.id,
    )
    expect(stored?.status).toBe('pending')
  })

  it('member is refused a blank custom text without a selection', async () => {
    // Given a pending question
    const context = await fixture()
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      { token: context.hostA.hostToken, body: { question_text: 'Anything?' } },
    )

    // When the member answers with only whitespace
    const answered = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: context.memberToken, body: { selected: [], custom: '   ' } },
    )

    // Then the empty answer is refused
    expect(answered.status).toBe(400)
    expect(answered.body.error.details.fields).toEqual(['selected', 'custom'])
  })

  it('member is refused a selection that is not a string array', async () => {
    // Given a pending question
    const context = await fixture()
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      { token: context.hostA.hostToken, body: { question_text: 'Anything?' } },
    )

    // When the answer carries a number in the selection
    const answered = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/questions/' + created.body.question.id + '/answer',
      { token: context.memberToken, body: { selected: [1] } },
    )

    // Then the shape of the answer is refused
    expect(answered.status).toBe(400)
    expect(answered.body.error.details.field).toBe('selected')
  })

  it('host is refused options that are bare strings instead of labelled objects', async () => {
    // Given a running card on host A
    const context = await fixture()

    // When the host sends the pre-A2 string options
    const created = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/questions',
      { token: context.hostA.hostToken, body: { question_text: 'which?', options: ['v1', 'v2'] } },
    )

    // Then the option shape is refused
    expect(created.status).toBe(400)
    expect(created.body.error.details.field).toBe('options')
  })
})

describe('activity wire shape', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member reads activity entries with one actor id and a parsed payload', async () => {
    // Given a card created by a member and claimed by a host
    const context = await fixture()

    // When the member reads the activity feed
    const feed = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/activity',
      { token: context.memberToken },
    )

    // Then every entry has the supplement A2 keys and a parsed payload object
    expect(feed.status).toBe(200)
    for (const entry of feed.body.activity) {
      expect(Object.keys(entry).sort()).toEqual(ACTIVITY_KEYS)
      expect(typeof entry.payload).toBe('object')
    }
    const claimed = feed.body.activity.find((entry: { activity_type: string }) => entry.activity_type === 'issue.claimed')
    expect(claimed).toMatchObject({ actor_type: 'host', actor_id: context.hostA.hostId })
    const createdEntry = feed.body.activity.find(
      (entry: { activity_type: string }) => entry.activity_type === 'issue.created',
    )
    expect(createdEntry).toMatchObject({ actor_type: 'member', actor_id: context.team.member.id })
    expect(createdEntry.payload).toEqual({ status: 'assigned', assignee_type: 'agent' })
  })

  it('member reads the payload of a comment entry as an object, never as JSON text', async () => {
    // Given a card with one comment
    const context = await fixture()
    const comment = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/comments',
      { token: context.memberToken, body: { content: 'audited comment' } },
    )

    // When the member reads the activity feed
    const feed = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.team.teamId + '/issues/' + context.issueId + '/activity',
      { token: context.memberToken },
    )

    // Then the comment entry carries the comment id inside an object payload
    const entry = feed.body.activity.find(
      (row: { activity_type: string }) => row.activity_type === 'comment.created',
    )
    expect(entry.payload).toEqual({ comment_id: comment.body.comment.id })
    const stored = await all<{ payload_json: string }>(
      context.env,
      "SELECT payload_json FROM activity WHERE activity_type = 'comment.created'",
    )
    expect(typeof stored[0]?.payload_json).toBe('string')
  })
})
