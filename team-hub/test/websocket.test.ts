import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  createEnv,
  externalTransport,
  seedHost,
  seedTeam,
  T0,
  tokenFor,
  upgrade,
  type GithubAccount,
} from './helpers'
import { QUESTION_TTL_MS, WS_FRAME_LIMIT_BYTES } from '../src/constants'
import { channelState } from '../src/channel'
import { sweepAllTeams } from '../src/domain/sweep'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

/** Every event name PROTOCOL.md section 9 defines. */
const SPEC_EVENTS = new Set([
  'issue.created',
  'issue.updated',
  'issue.status_changed',
  'issue.claimed',
  'issue.rework',
  'comment.created',
  'comment.mentioned',
  'question.created',
  'question.answered',
  'question.expired',
  'question.withdrawn',
  'host.status_changed',
])

interface Frame {
  t: string
  seq?: number
  event?: string
  payload?: any
  reason?: string
  latest_seq?: number
  ts?: number
}

class FrameQueue {
  readonly frames: Frame[] = []
  readonly observed: string[] = []
  readonly closed: { code: number; reason: string }[] = []
  #waiting: ((frame: Frame) => void)[] = []
  #closeWaiters: ((value: { code: number; reason: string }) => void)[] = []

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Frame
      if (frame.event !== undefined) this.observed.push(frame.event)
      const waiter = this.#waiting.shift()
      if (waiter) waiter(frame)
      else this.frames.push(frame)
    })
    socket.addEventListener('close', (event) => {
      const closed = { code: (event as CloseEvent).code ?? 1005, reason: String((event as CloseEvent).reason ?? '') }
      const waiter = this.#closeWaiters.shift()
      if (waiter) waiter(closed)
      else this.closed.push(closed)
    })
  }

  async next(): Promise<Frame> {
    const queued = this.frames.shift()
    if (queued) return queued
    return new Promise<Frame>((resolve) => this.#waiting.push(resolve))
  }

  async collect(count: number): Promise<Frame[]> {
    const out: Frame[] = []
    for (let index = 0; index < count; index += 1) out.push(await this.next())
    return out
  }

  /** Consume frames until the named event arrives, ignoring what preceded it. */
  async untilEvent(name: string): Promise<Frame> {
    for (;;) {
      const frame = await this.next()
      if (frame.event === name) return frame
    }
  }

  async nextClose(): Promise<{ code: number; reason: string }> {
    const queued = this.closed.shift()
    if (queued) return queued
    return new Promise((resolve) => this.#closeWaiters.push(resolve))
  }
}

/** Sequence a client should ask for to be caught up with the channel. */
async function latestSeq(env: Env, teamId: string): Promise<number> {
  return (await channelState(env, teamId)).latest_seq
}

async function openSocket(env: Env, teamId: string, token: string, sinceSeq: number) {
  const response = await upgrade(env, '/api/v1/teams/' + teamId + '/ws', {
    token,
    query: { protocol_version: '1.0.0', since_seq: String(sinceSeq) },
  })
  const socket = response.webSocket
  if (socket === null) throw new Error('the upgrade returned no socket, status ' + response.status)
  socket.accept()
  return { socket, queue: new FrameQueue(socket) }
}

async function connectMember(env: Env, teamId: string, token: string) {
  return openSocket(env, teamId, token, await latestSeq(env, teamId))
}

async function connectHost(env: Env, teamId: string, hostToken: string) {
  return openSocket(env, teamId, hostToken, await latestSeq(env, teamId))
}

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
  return { env, team, adminToken, memberToken, hostA, hostB }
}

describe('channel connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('guest is refused a socket without a session token', async () => {
    // Given a seeded team
    const context = await fixture()

    // When a client opens the channel without a token
    const response = await upgrade(context.env, '/api/v1/teams/' + context.team.teamId + '/ws', {
      query: { protocol_version: '1.0.0' },
    })

    // Then the handshake is refused
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('member is told to resync when connecting without a sequence', async () => {
    // Given a channel that already published host status changes, which a
    // fresh connection does not know about
    const context = await fixture()

    // When the member connects with since_seq 0
    const { queue } = await openSocket(context.env, context.team.teamId, context.memberToken, 0)

    // Then the channel asks for a full snapshot and names the latest sequence
    const frame = await queue.next()
    expect(frame.t).toBe('resync_required')
    expect(frame.latest_seq).toBeGreaterThan(0)
  })

  it('member replays missed events in order after reconnecting', async () => {
    // Given three events published after the sequence the client holds
    const context = await fixture()
    const checkpoint = await latestSeq(context.env, context.team.teamId)
    for (const title of ['one', 'two', 'three']) {
      await api(context.env, 'POST', '/api/v1/teams/' + context.team.teamId + '/issues', {
        token: context.memberToken,
        body: { title },
      })
    }

    // When the member reconnects from that checkpoint
    const { queue } = await openSocket(context.env, context.team.teamId, context.memberToken, checkpoint)

    // Then the three events are replayed in order
    const frames = await queue.collect(3)
    expect(frames.map((frame) => frame.seq)).toEqual([checkpoint + 1, checkpoint + 2, checkpoint + 3])
    expect(frames.every((frame) => frame.event === 'issue.created')).toBe(true)
  })

  it('member answers a ping with a pong carrying the same timestamp', async () => {
    // Given a connected member
    const context = await fixture()
    const { socket, queue } = await connectMember(context.env, context.team.teamId, context.memberToken)

    // When the ping arrives at the channel
    socket.send(JSON.stringify({ t: 'ping', ts: T0 + 7 }))

    // Then the pong echoes the timestamp
    expect(await queue.next()).toEqual({ t: 'pong', ts: T0 + 7 })
  })

  it('member socket is closed when it sends more frames than the quota allows', async () => {
    // Given a connected member
    const context = await fixture()
    const { socket, queue } = await connectMember(context.env, context.team.teamId, context.memberToken)

    // When it sends one frame more than the 60 per minute quota
    for (let index = 0; index < 61; index += 1) {
      socket.send(JSON.stringify({ t: 'ping', ts: T0 + index }))
    }

    // Then the channel closes the connection with a policy violation
    const closed = await queue.nextClose()
    expect(closed.code).toBe(1008)
    expect(closed.reason).toBe('RATE_LIMITED')
  })

  it('member socket is closed when a frame exceeds 64 KiB', async () => {
    // Given a connected member
    const context = await fixture()
    const { socket, queue } = await connectMember(context.env, context.team.teamId, context.memberToken)

    // When it sends a frame larger than the section 11 cap
    socket.send('x'.repeat(WS_FRAME_LIMIT_BYTES + 1))

    // Then the channel closes the connection as too large
    const closed = await queue.nextClose()
    expect(closed.code).toBe(1009)
    expect(closed.reason).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('channel events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('member receives the lifecycle events the specification defines', async () => {
    // Given a caught up member socket and a caught up bound host socket
    const context = await fixture()
    const member = await connectMember(context.env, context.team.teamId, context.memberToken)
    const host = await connectHost(context.env, context.team.teamId, context.hostA.hostToken)
    const base = '/api/v1/teams/' + context.team.teamId

    // When a card runs through creation, claiming, comments, a question, its
    // answer, settlement, rejection, a second run and approval
    const created = await api(context.env, 'POST', base + '/issues', {
      token: context.adminToken,
      body: { title: 'lifecycle', assignee_type: 'agent', assignee_id: context.hostA.agents[0]?.id },
    })
    const issueId = created.body.issue.id as string
    expect((await member.queue.untilEvent('issue.created')).payload.issue.id).toBe(issueId)

    const claim = await api(context.env, 'POST', base + '/issues/' + issueId + '/claim', {
      token: context.hostA.hostToken,
      body: {},
    })
    expect((await member.queue.untilEvent('issue.claimed')).payload.executing_host_id).toBe(context.hostA.hostId)
    await member.queue.untilEvent('issue.status_changed')
    await member.queue.untilEvent('issue.updated')

    await api(context.env, 'POST', base + '/issues/' + issueId + '/comments', {
      token: context.adminToken,
      body: { content: 'starting the run' },
    })
    expect((await member.queue.untilEvent('comment.created')).payload.comment.issue_id).toBe(issueId)

    const question = await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostA.hostToken,
      body: { question_text: 'which endpoint?' },
    })
    expect((await member.queue.untilEvent('question.created')).payload.question.id).toBe(question.body.question.id)

    await api(context.env, 'POST', base + '/questions/' + question.body.question.id + '/answer', {
      token: context.adminToken,
      body: { custom_text: 'the v1 one' },
    })
    expect((await member.queue.untilEvent('question.answered')).payload.responder_member_id).toBe(context.team.admin.id)

    await api(context.env, 'POST', base + '/issues/' + issueId + '/settle', {
      token: context.hostA.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id },
    })
    expect((await member.queue.untilEvent('issue.status_changed')).payload.new_status).toBe('in_review')
    await member.queue.untilEvent('issue.updated')

    await api(context.env, 'POST', base + '/issues/' + issueId + '/review/reject', {
      token: context.adminToken,
      body: { instructions: 'try again' },
    })
    expect((await member.queue.untilEvent('issue.status_changed')).payload.new_status).toBe('assigned')
    expect((await host.queue.untilEvent('issue.rework')).payload.instructions).toBe('try again')

    const secondClaim = await api(context.env, 'POST', base + '/issues/' + issueId + '/claim', {
      token: context.hostA.hostToken,
      body: {},
    })
    const claimFrames = await member.queue.collect(3)
    expect(claimFrames.map((frame) => frame.event)).toEqual([
      'issue.claimed',
      'issue.status_changed',
      'issue.updated',
    ])
    await api(context.env, 'POST', base + '/issues/' + issueId + '/settle', {
      token: context.hostA.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: secondClaim.body.execution_attempt_id },
    })
    const settleFrames = await member.queue.collect(2)
    expect(settleFrames[0]?.payload.new_status).toBe('in_review')
    await api(context.env, 'POST', base + '/issues/' + issueId + '/review/approve', {
      token: context.adminToken,
    })
    const approveFrames = await member.queue.collect(2)
    expect(approveFrames[1]?.payload.new_status).toBe('done')

    // Then every event name the channel emitted belongs to the specification
    expect(member.queue.observed.filter((name) => !SPEC_EVENTS.has(name))).toEqual([])
    expect(host.queue.observed.filter((name) => !SPEC_EVENTS.has(name))).toEqual([])
    expect(new Set(member.queue.observed)).toEqual(
      new Set([
        'issue.created',
        'issue.claimed',
        'issue.status_changed',
        'issue.updated',
        'comment.created',
        'question.created',
        'question.answered',
      ]),
    )
  })

  it('member receives question withdrawal and expiry events', async () => {
    // Given a running card with two pending questions and a caught up member
    const context = await fixture()
    const base = '/api/v1/teams/' + context.team.teamId
    const created = await api(context.env, 'POST', base + '/issues', {
      token: context.memberToken,
      body: { title: 'questions', assignee_type: 'agent', assignee_id: context.hostA.agents[0]?.id },
    })
    const issueId = created.body.issue.id as string
    await api(context.env, 'POST', base + '/issues/' + issueId + '/claim', { token: context.hostA.hostToken, body: {} })
    const member = await connectMember(context.env, context.team.teamId, context.memberToken)
    const first = await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostA.hostToken,
      body: { question_text: 'withdraw me' },
    })
    await member.queue.untilEvent('question.created')
    const second = await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostA.hostToken,
      body: { question_text: 'expire me' },
    })
    await member.queue.untilEvent('question.created')

    // When the host withdraws one and the other reaches its TTL
    await api(context.env, 'POST', base + '/questions/' + first.body.question.id + '/withdraw', {
      token: context.hostA.hostToken,
    })
    const withdrawn = await member.queue.untilEvent('question.withdrawn')
    await sweepAllTeams(context.env, T0 + QUESTION_TTL_MS + 1)
    const expired = await member.queue.untilEvent('question.expired')

    // Then both events carry the question and issue identifiers
    expect(withdrawn.payload).toEqual({ question_id: first.body.question.id, issue_id: issueId })
    expect(expired.payload).toEqual({ question_id: second.body.question.id, issue_id: issueId })
  })

  it('host receives mention and rework events while another host does not', async () => {
    // Given an agent card waiting in review on host A
    const context = await fixture()
    const base = '/api/v1/teams/' + context.team.teamId
    const created = await api(context.env, 'POST', base + '/issues', {
      token: context.memberToken,
      body: { title: 'targeted', assignee_type: 'agent', assignee_id: context.hostA.agents[0]?.id },
    })
    const issueId = created.body.issue.id as string
    const claim = await api(context.env, 'POST', base + '/issues/' + issueId + '/claim', {
      token: context.hostA.hostToken,
      body: {},
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/settle', {
      token: context.hostA.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id },
    })
    const hostA = await connectHost(context.env, context.team.teamId, context.hostA.hostToken)
    const hostB = await connectHost(context.env, context.team.teamId, context.hostB.hostToken)

    // When a comment mentions the agent and the review is rejected
    await api(context.env, 'POST', base + '/issues/' + issueId + '/comments', {
      token: context.memberToken,
      body: { content: '@' + (context.hostA.agents[0]?.name as string) + ' please continue' },
    })
    const mention = await hostA.queue.untilEvent('comment.mentioned')
    await api(context.env, 'POST', base + '/issues/' + issueId + '/review/reject', {
      token: context.memberToken,
      body: { instructions: 'one more round' },
    })
    const rework = await hostA.queue.untilEvent('issue.rework')

    // Then the bound host receives both targeted events
    expect(mention.payload.issue_id).toBe(issueId)
    expect(rework.payload).toEqual({
      issue_id: issueId,
      instructions: 'one more round',
      reviewer_member_id: context.team.member.id,
    })

    // And the other host only receives the team wide events of that rejection
    const hostBFrames = await hostB.queue.collect(3)
    expect(hostBFrames.map((frame) => frame.event).sort()).toEqual([
      'comment.created',
      'issue.status_changed',
      'issue.updated',
    ])
    expect(hostB.queue.observed).not.toContain('issue.rework')
    expect(hostB.queue.observed).not.toContain('comment.mentioned')
  })

  it('member is told when the host goes offline', async () => {
    // Given a caught up member and an online host
    const context = await fixture()
    const member = await connectMember(context.env, context.team.teamId, context.memberToken)

    // When the host misses three heartbeats and the sweep runs
    await sweepAllTeams(context.env, T0 + 60_000)
    const offline = await member.queue.untilEvent('host.status_changed')

    // Then the status change reaches the team
    expect(offline.payload).toEqual({ host_id: context.hostA.hostId, status: 'offline' })
  })
})