import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import {
  api,
  createIssue,
  openSocket,
  seedHost,
  seedTeam,
  startTestHub,
  type FrameQueue,
  type TestHub,
} from './helpers'

/**
 * The WebSocket surface against real sockets: handshake authentication through
 * the Authorization header, version negotiation, the resync directive and the
 * since_seq replay the protocol promises.
 */

interface Connected {
  hub: TestHub
  teamId: string
  adminToken: string
  sockets: WebSocket[]
}

let active: TestHub | null = null
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets) socket.close()
  sockets.length = 0
  if (active !== null) await active.close()
  active = null
})

async function fixture(): Promise<Connected> {
  const hub = await startTestHub()
  active = hub
  const team = await seedTeam(hub)
  return { hub, teamId: team.teamId, adminToken: team.admin.accessToken, sockets }
}

async function connect(
  context: Connected,
  options: { token?: string; query?: Record<string, string>; omitProtocol?: boolean },
): Promise<{ queue: FrameQueue; socket: WebSocket }> {
  const result = await openSocket(context.hub, context.teamId, options)
  if (!result.ok) throw new Error('handshake refused: ' + result.status + ' ' + JSON.stringify(result.body))
  sockets.push(result.socket)
  return { queue: result.queue, socket: result.socket }
}

function latestSeq(context: Connected): number {
  return context.hub.hub.channel.state(context.teamId).latest_seq
}

/**
 * Connect at the current head. A brand new channel has sequence 0, which the
 * protocol reads as "no sequence" and answers with resync_required; that frame
 * is consumed here so the caller sees only what happens from now on.
 */
async function connectCaughtUp(context: Connected, token: string): Promise<{ queue: FrameQueue; socket: WebSocket }> {
  const checkpoint = latestSeq(context)
  const connected = await connect(context, {
    token,
    query: { protocol_version: '1.0.0', since_seq: String(checkpoint) },
  })
  if (checkpoint === 0) {
    const frame = await connected.queue.next()
    if (frame.t !== 'resync_required') throw new Error('expected a resync directive, got ' + JSON.stringify(frame))
  }
  return connected
}

describe('channel handshake', () => {
  it('refuses a socket without credentials', async () => {
    // Given a team with a live channel
    const context = await fixture()

    // When a guest opens the channel with no authorization header
    const result = await openSocket(context.hub, context.teamId, {
      query: { protocol_version: '1.0.0' },
    })
    if (result.ok) throw new Error('expected the handshake to be refused')

    // Then the handshake is refused before a socket exists
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
  })

  it('refuses a token carried in the query string', async () => {
    // Given a member with a valid session
    const context = await fixture()

    // When the token is smuggled through the URL instead of the header
    const result = await openSocket(context.hub, context.teamId, {
      query: { protocol_version: '1.0.0', token: context.adminToken },
    })
    if (result.ok) throw new Error('expected the handshake to be refused')

    // Then the channel refuses it, because tokens never belong in a URL
    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('UNAUTHORIZED')
  })

  it('refuses a handshake with no protocol version', async () => {
    // Given a member with a valid session
    const context = await fixture()

    // When the handshake declares no version at all
    const result = await openSocket(context.hub, context.teamId, {
      token: context.adminToken,
      omitProtocol: true,
      query: { since_seq: '0' },
    })
    if (result.ok) throw new Error('expected the handshake to be refused')

    // Then version negotiation refuses it before the socket opens
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION')
  })

  it('asks for a snapshot when the client brings no sequence', async () => {
    // Given a channel that already published events
    const context = await fixture()
    await createIssue(context.hub, context.teamId, context.adminToken, { title: 'first' })

    // When the member connects with since_seq 0
    const { queue } = await connect(context, {
      token: context.adminToken,
      query: { protocol_version: '1.0.0', since_seq: '0' },
    })

    // Then the channel asks for a full snapshot and names its latest sequence
    const frame = await queue.next()
    expect(frame.t).toBe('resync_required')
    expect(frame.reason).toBe('no_sequence')
    expect(frame.latest_seq).toBeGreaterThan(0)
    expect(frame.latest_seq).toBe(latestSeq(context))
  })
})

describe('replay and live delivery', () => {
  it('replays every event after the sequence the client holds', async () => {
    // Given a channel with history, and three issues created after the
    // checkpoint the client stopped at
    const context = await fixture()
    await createIssue(context.hub, context.teamId, context.adminToken, { title: 'baseline' })
    const checkpoint = latestSeq(context)
    const created = []
    for (const title of ['one', 'two', 'three']) {
      created.push(await createIssue(context.hub, context.teamId, context.adminToken, { title }))
    }

    // When the member reconnects from that checkpoint
    const { queue } = await connect(context, {
      token: context.adminToken,
      query: { protocol_version: '1.0.0', since_seq: String(checkpoint) },
    })

    // Then the three issue.created events arrive in order, with their payloads
    const frames = await queue.collect(3)
    expect(frames.map((frame) => frame.seq)).toEqual([checkpoint + 1, checkpoint + 2, checkpoint + 3])
    expect(frames.every((frame) => frame.t === 'event' && frame.event === 'issue.created')).toBe(true)
    expect(frames.map((frame) => frame.payload.issue.id)).toEqual(created.map((issue) => issue.id))
    expect(frames[0]?.payload.issue).toMatchObject({
      title: 'one',
      status: 'todo',
      has_lease: false,
      lease_expires_at: null,
    })
  })

  it('delivers events published while the socket is open', async () => {
    // Given a caught-up member socket
    const context = await fixture()
    await createIssue(context.hub, context.teamId, context.adminToken, { title: 'baseline' })
    const { queue } = await connectCaughtUp(context, context.adminToken)

    // When an issue is created over HTTP
    const issue = await createIssue(context.hub, context.teamId, context.adminToken, { title: 'live' })

    // Then the same event arrives on the socket
    const frame = await queue.next()
    expect(frame.t).toBe('event')
    expect(frame.event).toBe('issue.created')
    expect(frame.payload.issue.id).toBe(issue.id)
  })

  it('answers a client ping with its own timestamp', async () => {
    // Given a connected member
    const context = await fixture()
    await createIssue(context.hub, context.teamId, context.adminToken, { title: 'baseline' })
    const { queue, socket } = await connectCaughtUp(context, context.adminToken)

    // When the client pings
    socket.send(JSON.stringify({ t: 'ping', ts: 1_700_000_000_123 }))

    // Then the pong carries the same timestamp
    expect(await queue.next()).toEqual({ t: 'pong', ts: 1_700_000_000_123 })
  })

  it('delivers a host-targeted event only to that host', async () => {
    // Given two registered hosts and a member socket
    const context = await fixture()
    const hostA = await seedHost(context.hub, context.teamId, context.adminToken, {
      hostname: 'host-a',
      agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
    })
    const hostB = await seedHost(context.hub, context.teamId, context.adminToken, {
      hostname: 'host-b',
      agents: [{ name: 'dev-bot', preset_id: 'liangshen' }],
    })
    const member = await connectCaughtUp(context, context.adminToken)
    const a = await connectCaughtUp(context, hostA.hostToken)
    const b = await connectCaughtUp(context, hostB.hostToken)

    // When a comment mentions host A's agent
    const issue = await createIssue(context.hub, context.teamId, context.adminToken, {
      title: 'targeted',
      assignee_type: 'agent',
      assignee_id: hostA.agents[0]?.id,
    })
    const issueCreated = await member.queue.next()
    expect(issueCreated.event).toBe('issue.created')
    expect((await a.queue.next()).event).toBe('issue.created')
    expect((await b.queue.next()).event).toBe('issue.created')
    await api(context.hub, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + issue.id + '/comments', {
      token: context.adminToken,
      body: { content: '@qa-bot please continue' },
    })

    // Then only the bound host receives the mention, after the team-wide comment
    expect((await a.queue.next()).event).toBe('comment.created')
    const mentioned = await a.queue.next()
    expect(mentioned.event).toBe('comment.mentioned')
    expect(mentioned.payload).toMatchObject({ issue_id: issue.id, author: 'Octo Cat' })
    expect((await b.queue.next()).event).toBe('comment.created')
    b.socket.send(JSON.stringify({ t: 'ping', ts: 7 }))
    expect((await b.queue.next()).t).toBe('pong')
    expect(b.queue.observed).not.toContain('comment.mentioned')
  })
})
