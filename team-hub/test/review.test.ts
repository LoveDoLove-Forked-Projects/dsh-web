import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  all,
  api,
  createEnv,
  externalTransport,
  one,
  seedHost,
  seedExtraMember,
  seedTeam,
  T0,
  tokenFor,
  type GithubAccount,
} from './helpers'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

interface ReviewFixture {
  env: Env
  teamId: string
  issueId: string
  hostToken: string
  hostId: string
  otherHostToken: string
  reviewerToken: string
  adminToken: string
  firstAttemptId: string
}

/** An agent issue that already settled successfully, so it waits in review. */
async function inReviewIssue(): Promise<ReviewFixture> {
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
  const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
    token: reviewerToken,
    body: { title: 'Run the suite', assignee_type: 'agent', assignee_id: hostA.agents[0]?.id },
  })
  const issueId = created.body.issue.id as string
  const claim = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
    token: hostA.hostToken,
    body: {},
  })
  await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/settle', {
    token: hostA.hostToken,
    body: { outcome: 'succeeded', summary: 'green', execution_attempt_id: claim.body.execution_attempt_id },
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
    firstAttemptId: claim.body.execution_attempt_id as string,
  }
}

describe('human review', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reviewer approves an in review issue and it becomes done', async () => {
    // Given an agent issue waiting in review
    const fixture = await inReviewIssue()

    // When the reviewer approves it
    const approved = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/approve',
      { token: fixture.reviewerToken },
    )

    // Then the collaboration status is done and the approval is audited
    expect(approved.status).toBe(200)
    expect(approved.body).toEqual({ ok: true, status: 'done' })
    const activity = await all<{ activity_type: string }>(
      fixture.env,
      'SELECT activity_type FROM activity WHERE issue_id = ?',
      fixture.issueId,
    )
    expect(activity.map((row) => row.activity_type)).toContain('issue.approved')
  })

  it('reviewer is refused approval of an issue that is not in review', async () => {
    // Given an agent issue that is still running
    const fixture = await inReviewIssue()
    await fixture.env.DB.prepare("UPDATE issues SET status = 'running' WHERE id = ?").bind(fixture.issueId).run()

    // When the reviewer approves it
    const approved = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/approve',
      { token: fixture.reviewerToken },
    )

    // Then the state machine refuses the transition
    expect(approved.status).toBe(422)
    expect(approved.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('member who is not the reviewer is refused the decision', async () => {
    // Given an in review issue reviewed by one member and a third plain member
    const fixture = await inReviewIssue()
    const third = await seedExtraMember(fixture.env, fixture.teamId, { githubId: 1003, username: 'thirdperson' })
    const outsiderToken = await tokenFor(fixture.env, third)

    // When a plain member who is not the reviewer approves it
    const approved = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/approve',
      { token: outsiderToken },
    )

    // Then the review decision is forbidden
    expect(approved.status).toBe(403)
    expect(approved.body.error.code).toBe('FORBIDDEN')
  })

  it('admin approves a review they were not assigned to review', async () => {
    // Given an in review issue reviewed by a plain member
    const fixture = await inReviewIssue()

    // When the admin approves it
    const approved = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/approve',
      { token: fixture.adminToken },
    )

    // Then the admin decision is accepted
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('done')
  })

  it('reviewer rejects with instructions and the card goes back to the host', async () => {
    // Given an agent issue waiting in review
    const fixture = await inReviewIssue()

    // When the reviewer rejects it with rework instructions
    const rejected = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject',
      { token: fixture.reviewerToken, body: { instructions: 'Please add a regression test' } },
    )

    // Then the instructions are stored, the lease is clear and the card is
    // assigned again rather than running
    expect(rejected.status).toBe(200)
    expect(rejected.body).toEqual({ ok: true, status: 'assigned' })
    const stored = await one<{
      status: string
      rework_instructions: string
      lease_token: string | null
      execution_attempt_id: string | null
    }>(
      fixture.env,
      'SELECT status, rework_instructions, lease_token, execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(stored).toEqual({
      status: 'assigned',
      rework_instructions: 'Please add a regression test',
      lease_token: null,
      execution_attempt_id: null,
    })
  })

  it('host claims only after the rework signal and then runs a fresh attempt', async () => {
    // Given a rejected issue that nobody has claimed yet
    const fixture = await inReviewIssue()
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject', {
      token: fixture.reviewerToken,
      body: { instructions: 'Retry with the fix' },
    })
    const beforeClaim = await one<{ status: string; execution_attempt_id: string | null }>(
      fixture.env,
      'SELECT status, execution_attempt_id FROM issues WHERE id = ?',
      fixture.issueId,
    )
    expect(beforeClaim).toEqual({ status: 'assigned', execution_attempt_id: null })

    // When the bound host claims the reworked card
    const claim = await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/claim', {
      token: fixture.hostToken,
      body: {},
    })

    // Then a new execution attempt starts and only the bound host could start it
    expect(claim.status).toBe(200)
    expect(claim.body.execution_attempt_id).not.toBe(fixture.firstAttemptId)
    const other = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/claim',
      { token: fixture.otherHostToken, body: {} },
    )
    expect(other.status).toBe(403)
    const afterClaim = await one<{ status: string }>(fixture.env, 'SELECT status FROM issues WHERE id = ?', fixture.issueId)
    expect(afterClaim?.status).toBe('running')
  })

  it('reviewer is refused a second rejection of the same review', async () => {
    // Given an issue that was already rejected once
    const fixture = await inReviewIssue()
    await api(fixture.env, 'POST', '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject', {
      token: fixture.reviewerToken,
      body: { instructions: 'first rejection' },
    })

    // When a rejection arrives again while the card is only assigned
    const second = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject',
      { token: fixture.reviewerToken, body: { instructions: 'second rejection' } },
    )

    // Then the state machine refuses it, so rework cannot start twice
    expect(second.status).toBe(422)
    expect(second.body.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('reviewer is refused a rejection without instructions', async () => {
    // Given an in review issue
    const fixture = await inReviewIssue()

    // When the reviewer rejects without instructions
    const rejected = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject',
      { token: fixture.reviewerToken, body: { instructions: '   ' } },
    )

    // Then the request is refused as a validation failure
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('reviewer rejection parks the card when the bound host is offline', async () => {
    // Given an in review issue whose host went offline
    const fixture = await inReviewIssue()
    await fixture.env.DB.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").bind(fixture.hostId).run()

    // When the reviewer rejects it
    const rejected = await api(
      fixture.env,
      'POST',
      '/api/v1/teams/' + fixture.teamId + '/issues/' + fixture.issueId + '/review/reject',
      { token: fixture.reviewerToken, body: { instructions: 'fix it' } },
    )

    // Then it waits for its execution node instead of being handed elsewhere
    expect(rejected.body.status).toBe('waiting_host')
    const stored = await one<{ status: string }>(fixture.env, 'SELECT status FROM issues WHERE id = ?', fixture.issueId)
    expect(stored?.status).toBe('waiting_host')
  })
})