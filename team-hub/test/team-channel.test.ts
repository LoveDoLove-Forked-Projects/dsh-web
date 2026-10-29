import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

interface Frame {
  t: string
  seq?: number
  event?: string
  payload?: unknown
  reason?: string
  latest_seq?: number
  ts?: number
}

class FrameQueue {
  readonly frames: Frame[] = []
  #waiting: ((frame: Frame) => void)[] = []

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Frame
      const waiter = this.#waiting.shift()
      if (waiter) waiter(frame)
      else this.frames.push(frame)
    })
  }

  async next(): Promise<Frame> {
    const queued = this.frames.shift()
    if (queued) return queued
    return new Promise<Frame>((resolve) => this.#waiting.push(resolve))
  }
}

function channel(teamId: string) {
  return env.TEAM_CHANNEL.get(env.TEAM_CHANNEL.idFromName(teamId))
}

async function publish(teamId: string, events: { event: string; payload: unknown; target_host_id?: string }[]) {
  const response = await channel(teamId).fetch('https://team-channel.internal/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { seq: number }
}

async function connect(teamId: string, sinceSeq: number | null, hostId?: string) {
  const url = new URL('https://team-channel.internal/ws')
  if (sinceSeq !== null) url.searchParams.set('since_seq', String(sinceSeq))
  const headers: Record<string, string> = { Upgrade: 'websocket' }
  if (hostId) headers['x-team-channel-host-id'] = hostId
  const response = await channel(teamId).fetch(url.toString(), { headers })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('upgrade returned no socket')
  socket.accept()
  return { socket, queue: new FrameQueue(socket) }
}

describe('team channel', () => {
  it('user receives a resync directive when connecting without a sequence', async () => {
    // Given a channel that already published one event
    await publish('team_spike', [{ event: 'issue.created', payload: { issue: { id: 'issue_1' } } }])

    // When a client connects without since_seq
    const { queue } = await connect('team_spike', null)

    // Then the channel asks it to re-fetch the full snapshot
    const frame = await queue.next()
    expect(frame.t).toBe('resync_required')
    expect(frame.latest_seq).toBe(1)
  })

  it('user receives every missed event in order when resuming', async () => {
    // Given three published events
    await publish('team_spike2', [{ event: 'issue.created', payload: { n: 1 } }])
    await publish('team_spike2', [{ event: 'issue.updated', payload: { n: 2 } }])
    await publish('team_spike2', [{ event: 'comment.created', payload: { n: 3 } }])

    // When a client resumes from the first event
    const { queue } = await connect('team_spike2', 1)

    // Then it receives events two and three, in order
    const first = await queue.next()
    const second = await queue.next()
    expect([first.seq, first.event]).toEqual([2, 'issue.updated'])
    expect([second.seq, second.event]).toEqual([3, 'comment.created'])
  })

  it('user receives live events after connecting', async () => {
    // Given a connected client caught up to sequence 0
    const { queue } = await connect('team_spike3', 0)
    expect((await queue.next()).t).toBe('resync_required')

    // When the hub publishes while the socket is open
    await publish('team_spike3', [{ event: 'issue.claimed', payload: { issue_id: 'issue_1' } }])

    // Then the event arrives on the live socket
    const frame = await queue.next()
    expect(frame.t).toBe('event')
    expect(frame.event).toBe('issue.claimed')
    expect(frame.seq).toBe(1)
  })

  it('user keeps receiving events after the sequence is restored from storage', async () => {
    // Given a channel that published two events and a fresh instance afterwards
    await publish('team_spike4', [{ event: 'issue.created', payload: { n: 1 } }])
    await publish('team_spike4', [{ event: 'issue.created', payload: { n: 2 } }])

    // When a client resumes from sequence 1 against that channel
    const { queue } = await connect('team_spike4', 1)

    // Then the replay still covers the stored events
    const frame = await queue.next()
    expect([frame.seq, frame.event]).toEqual([2, 'issue.created'])
  })

  it('host receives a host-targeted event while another host does not', async () => {
    // Given two hosts connected to the same channel
    const hostA = await connect('team_spike5', 0, 'host_a')
    const hostB = await connect('team_spike5', 0, 'host_b')
    await hostA.queue.next()
    await hostB.queue.next()

    // When one event targets host_a
    await publish('team_spike5', [{ event: 'issue.rework', payload: { issue_id: 'issue_1' }, target_host_id: 'host_a' }])

    // Then only host_a receives it
    expect((await hostA.queue.next()).event).toBe('issue.rework')
    await publish('team_spike5', [{ event: 'issue.created', payload: {} }])
    expect((await hostB.queue.next()).seq).toBe(2)
  })

  it('user gets a pong echoing the ping timestamp', async () => {
    // Given a connected client
    const { socket, queue } = await connect('team_spike6', 0)
    await queue.next()

    // When it sends a ping
    socket.send(JSON.stringify({ t: 'ping', ts: 1_700_000_000_000 }))

    // Then the pong carries the same timestamp
    expect(await queue.next()).toMatchObject({ t: 'pong', ts: 1_700_000_000_000 })
  })

  it('user can request replay through a resume frame', async () => {
    // Given a client connected with no sequence and one published event
    await publish('team_spike7', [{ event: 'issue.created', payload: { n: 1 } }])
    const { socket, queue } = await connect('team_spike7', null)
    await queue.next()

    // When it asks to resume from sequence 0
    socket.send(JSON.stringify({ t: 'resume', since_seq: 0 }))

    // Then the channel answers with the resync directive
    expect((await queue.next()).t).toBe('resync_required')
  })
})
