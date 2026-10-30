import { afterEach, describe, expect, it } from 'vitest'
import {
  api,
  createIssue,
  inviteAndLogin,
  one,
  seedHost,
  seedTeam,
  startTestHub,
  type Session,
  type TestHub,
} from './helpers'

/**
 * The question routes against the real service: ask, list, answer, withdraw and
 * the two refusal codes that keep one question to one answer.
 */

let active: TestHub | null = null

afterEach(async () => {
  if (active !== null) await active.close()
  active = null
})

interface Fixture {
  hub: TestHub
  teamId: string
  adminToken: string
  host: { hostId: string; hostToken: string; agents: { id: string; name: string }[] }
  otherHost: { hostId: string; hostToken: string; agents: { id: string; name: string }[] }
  issue: { id: string }
}

async function runningFixture(): Promise<Fixture> {
  const hub = await startTestHub()
  active = hub
  const team = await seedTeam(hub)
  const host = await seedHost(hub, team.teamId, team.admin.accessToken, {
    hostname: 'host-a',
    agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
  })
  const otherHost = await seedHost(hub, team.teamId, team.admin.accessToken, {
    hostname: 'host-b',
    agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
  })
  const issue = await createIssue(hub, team.teamId, team.admin.accessToken, {
    title: 'question routing',
    assignee_type: 'agent',
    assignee_id: host.agents[0]?.id,
  })
  const claimed = await api(hub, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issue.id + '/claim', {
    token: host.hostToken,
    body: {},
  })
  if (claimed.status !== 200) throw new Error('claim failed: ' + claimed.text)
  return { hub, teamId: team.teamId, adminToken: team.admin.accessToken, host, otherHost, issue }
}

function base(fixture: Fixture): string {
  return '/api/v1/teams/' + fixture.teamId
}

async function ask(fixture: Fixture, body: Record<string, unknown>): Promise<any> {
  const created = await api(fixture.hub, 'POST', base(fixture) + '/issues/' + fixture.issue.id + '/questions', {
    token: fixture.host.hostToken,
    body,
  })
  if (created.status !== 201) throw new Error('question creation failed: ' + created.status + ' ' + created.text)
  return created.body.question
}

describe('asking and listing questions', () => {
  it('host asks a question the member list carries with its options', async () => {
    // Given a running card
    const fixture = await runningFixture()

    // When its host asks a multiple-choice question
    const created = await api(
      fixture.hub,
      'POST',
      base(fixture) + '/issues/' + fixture.issue.id + '/questions',
      {
        token: fixture.host.hostToken,
        body: {
          question_text: 'Which endpoint should ship first?',
          options: [{ label: 'Plan A', description: 'Ship v1' }, { label: 'Plan B' }],
          multi_select: true,
        },
      },
    )

    // Then the question comes back in the protocol's shape
    expect(created.status).toBe(201)
    expect(created.body.question).toMatchObject({
      issue_id: fixture.issue.id,
      text: 'Which endpoint should ship first?',
      options: [{ label: 'Plan A', description: 'Ship v1' }, { label: 'Plan B' }],
      multi_select: true,
      status: 'pending',
      answer: null,
      first_responder_member_id: null,
      answered_at: null,
    })

    // And the pending list, filtered to that issue, holds it
    const listed = await api(
      fixture.hub,
      'GET',
      base(fixture) + '/questions',
      { token: fixture.adminToken, query: { status: 'pending', issue_id: fixture.issue.id } },
    )
    expect(listed.status).toBe(200)
    expect(listed.body.questions.map((question: { id: string }) => question.id)).toEqual([created.body.question.id])
  })

  it('refuses a question that does not come from the running host', async () => {
    // Given a running card and a host that does not own its agent
    const fixture = await runningFixture()

    // When that other host asks
    const foreign = await api(
      fixture.hub,
      'POST',
      base(fixture) + '/issues/' + fixture.issue.id + '/questions',
      { token: fixture.otherHost.hostToken, body: { question_text: 'may I?' } },
    )

    // Then the hub says the card is not this host's to ask about
    expect(foreign.status).toBe(403)
    expect(foreign.body.error.code).toBe('HOST_MISMATCH')

    // And a question on an unclaimed card is a state transition error
    const assigned = await createIssue(fixture.hub, fixture.teamId, fixture.adminToken, {
      title: 'not running',
      assignee_type: 'agent',
      assignee_id: fixture.host.agents[0]?.id,
    })
    const early = await api(fixture.hub, 'POST', base(fixture) + '/issues/' + assigned.id + '/questions', {
      token: fixture.host.hostToken,
      body: { question_text: 'too early?' },
    })
    expect(early.status).toBe(422)
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('rejects an unknown question status filter', async () => {
    const fixture = await runningFixture()

    const listed = await api(fixture.hub, 'GET', base(fixture) + '/questions', {
      token: fixture.adminToken,
      query: { status: 'pending-ish' },
    })

    expect(listed.status).toBe(400)
    expect(listed.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('answering and withdrawing questions', () => {
  it('the first response wins and is exposed with the answer object', async () => {
    // Given a pending question
    const fixture = await runningFixture()
    const question = await ask(fixture, {
      question_text: 'which one?',
      options: [{ label: 'Plan A' }, { label: 'Plan B' }],
    })

    // When a member answers with an empty body
    const empty = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/answer', {
      token: fixture.adminToken,
      body: {},
    })

    // Then an answer needs a selection or a custom text
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('VALIDATION_FAILED')

    // When the member answers properly
    const answered = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/answer', {
      token: fixture.adminToken,
      body: { selected: ['Plan A'], custom: 'Ship the v1 endpoint first' },
    })

    // Then the question is answered and carries who answered first
    expect(answered.status).toBe(200)
    expect(answered.body).toEqual({ ok: true })
    const listed = await api(fixture.hub, 'GET', base(fixture) + '/questions', {
      token: fixture.adminToken,
      query: { status: 'answered' },
    })
    expect(listed.body.questions[0]).toMatchObject({
      id: question.id,
      status: 'answered',
      answer: { selected: ['Plan A'], custom: 'Ship the v1 endpoint first' },
    })
    expect(listed.body.questions[0].first_responder_member_id).toBeTruthy()
    expect(typeof listed.body.questions[0].answered_at).toBe('number')

    // And a second answer is refused with the original responder named
    const second = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/answer', {
      token: fixture.adminToken,
      body: { custom: 'Plan B after all' },
    })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('QUESTION_ALREADY_ANSWERED')
    expect(second.body.error.details.first_responder_member_id).toBeTruthy()
  })

  it('the admin withdraws a pending question and a plain member may not', async () => {
    // Given a pending question and a plain member
    const fixture = await runningFixture()
    const question = await ask(fixture, { question_text: 'withdraw me' })
    const member: Session = await inviteAndLogin(fixture.hub, fixture.teamId, fixture.adminToken, 'hubot')

    // When the plain member tries to withdraw it
    const refused = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/withdraw', {
      token: member.accessToken,
    })

    // Then only an admin or the asking host may
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('FORBIDDEN')

    // When the admin withdraws it
    const withdrawn = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/withdraw', {
      token: fixture.adminToken,
    })

    // Then the question is dismissed, and only once
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body).toEqual({ ok: true, status: 'dismissed' })
    const again = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/withdraw', {
      token: fixture.adminToken,
    })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('QUESTION_NOT_PENDING')

    // And an answered question cannot be withdrawn either
    const second = await ask(fixture, { question_text: 'answer me' })
    await api(fixture.hub, 'POST', base(fixture) + '/questions/' + second.id + '/answer', {
      token: fixture.adminToken,
      body: { custom: 'done' },
    })
    const late = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + second.id + '/withdraw', {
      token: fixture.adminToken,
    })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe('QUESTION_NOT_PENDING')
  })

  it('an expired question cannot be answered', async () => {
    // Given a pending question whose TTL lapsed and the sweep expired it
    const fixture = await runningFixture()
    const question = await ask(fixture, { question_text: 'too late?' })
    fixture.hub.sqlite.prepare('UPDATE questions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, question.id)
    await fixture.hub.hub.sweep()
    expect(one<{ status: string }>(fixture.hub, 'SELECT status FROM questions WHERE id = ?', question.id)?.status).toBe(
      'expired',
    )

    // When a member answers it
    const answered = await api(fixture.hub, 'POST', base(fixture) + '/questions/' + question.id + '/answer', {
      token: fixture.adminToken,
      body: { custom: 'late' },
    })

    // Then the state machine refuses
    expect(answered.status).toBe(409)
    expect(answered.body.error.code).toBe('QUESTION_NOT_PENDING')
  })
})
