import {
  EVENT_BUFFER_MAX_EVENTS,
  EVENT_BUFFER_WINDOW_MS,
  RATE_LIMIT_WS_FRAMES,
  RATE_LIMIT_WINDOW_MS,
  WS_FRAME_LIMIT_BYTES,
} from '../../src/constants'

/**
 * In-process replacement for the per-team Durable Object.
 *
 * The Durable Object did two things: it serialised the team's writes and it
 * held the team's event sequence, replay buffer and sockets. A single Node
 * process already serialises its writes on the event loop, so this module
 * keeps only the channel half. Sequence assignment, the section 13 buffer
 * bounds, resumption rules, host-targeted delivery and the frame limits below
 * are the same code paths the Durable Object implemented, so a client cannot
 * tell which one it is talking to.
 *
 * Nothing is persisted. A restart starts the sequence at zero, and a client
 * reconnecting with an old since_seq receives resync_required and re-fetches
 * the snapshot, which is the section 9 recovery path already in the protocol.
 */

export interface ChannelEvent {
  event: string
  payload: unknown
  target_host_id?: string | null
}

interface StoredFrame {
  seq: number
  event: string
  payload: unknown
  ts: number
  target_host_id: string | null
}

/** The slice of a socket this channel needs; the ws adapter supplies it. */
export interface ChannelSocket {
  send(data: string): void
  close(code: number, reason: string): void
}

interface ConnectionState {
  id: number
  hostId: string | null
  socket: ChannelSocket | null
  /** Frames produced before the HTTP upgrade completed, in send order. */
  outbox: string[]
  frameTimestamps: number[]
}

interface TeamState {
  sequence: number
  buffer: StoredFrame[]
  connections: Map<number, ConnectionState>
}

export interface UpgradePlan {
  teamId: string
  connectionId: number
}

/**
 * A response carrying an upgrade plan in this WeakMap is not an HTTP response
 * at all: the Node entry point completes the WebSocket handshake instead. The
 * shared router reaches the channel through the Durable Object stub interface,
 * so the plan travels beside its Response rather than changing the router.
 */
export const upgradePlans = new WeakMap<Response, UpgradePlan>()

const WS_PATH = '/ws'
const BROADCAST_PATH = '/broadcast'
const STATE_PATH = '/state'

function channelError(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 })
}

export class TeamChannels {
  readonly #teams = new Map<string, TeamState>()
  #nextConnectionId = 1

  /** The env.TEAM_CHANNEL binding the shared router and domain code call. */
  readonly namespace: DurableObjectNamespace = {
    idFromName: (name: string) => name,
    get: (teamId: string) => ({
      fetch: (input: Request | string, init?: RequestInit) => this.#handle(teamId, input, init),
    }),
  }

  #teamsState(teamId: string): TeamState {
    let state = this.#teams.get(teamId)
    if (state === undefined) {
      state = { sequence: 0, buffer: [], connections: new Map() }
      this.#teams.set(teamId, state)
    }
    return state
  }

  /** Latest and oldest sequence the replay buffer still holds. */
  state(teamId: string): { latest_seq: number; oldest_seq: number | null } {
    const state = this.#teamsState(teamId)
    const head = state.buffer[0]
    return { latest_seq: state.sequence, oldest_seq: head === undefined ? null : head.seq }
  }

  async #handle(teamId: string, input: Request | string, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === WS_PATH) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return channelError('VALIDATION_FAILED', 'expected a WebSocket upgrade')
      }
      return this.#open(teamId, url, request)
    }
    if (url.pathname === BROADCAST_PATH) return this.#broadcast(teamId, request)
    if (url.pathname === STATE_PATH) {
      const state = this.#teamsState(teamId)
      const head = state.buffer[0]
      return Response.json({
        latest_seq: state.sequence,
        oldest_seq: head === undefined ? null : head.seq,
        connections: state.connections.size,
      })
    }
    return new Response('unknown channel route', { status: 404 })
  }

  #open(teamId: string, url: URL, request: Request): Response {
    const state = this.#teamsState(teamId)
    const connection: ConnectionState = {
      id: this.#nextConnectionId,
      hostId: request.headers.get('x-team-channel-host-id'),
      socket: null,
      outbox: [],
      frameTimestamps: [],
    }
    this.#nextConnectionId += 1
    state.connections.set(connection.id, connection)
    const sinceParam = url.searchParams.get('since_seq')
    const since = sinceParam === null ? null : Number.parseInt(sinceParam, 10)
    this.#resume(state, connection, Number.isFinite(since) ? since : null)
    const response = new Response(null, { status: 200 })
    upgradePlans.set(response, { teamId, connectionId: connection.id })
    return response
  }

  /** Finish a handshake the router authorised; queued frames go out first. */
  attach(plan: UpgradePlan, socket: ChannelSocket): void {
    const connection = this.#teams.get(plan.teamId)?.connections.get(plan.connectionId)
    if (connection === undefined) {
      socket.close(1001, 'channel_closed')
      return
    }
    connection.socket = socket
    const queued = connection.outbox
    connection.outbox = []
    for (const frame of queued) socket.send(frame)
  }

  detach(plan: UpgradePlan): void {
    this.#teams.get(plan.teamId)?.connections.delete(plan.connectionId)
  }

  /** A frame from the client: the section 9 client frame table. */
  onFrame(plan: UpgradePlan, data: string, binary: boolean): void {
    const state = this.#teams.get(plan.teamId)
    const connection = state?.connections.get(plan.connectionId)
    if (state === undefined || connection === undefined) return
    if (binary) {
      this.#close(state, connection, 1003, 'text_frames_only')
      return
    }
    if (Buffer.byteLength(data, 'utf8') > WS_FRAME_LIMIT_BYTES) {
      this.#close(state, connection, 1009, 'PAYLOAD_TOO_LARGE')
      return
    }
    const now = Date.now()
    connection.frameTimestamps = connection.frameTimestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
    connection.frameTimestamps.push(now)
    if (connection.frameTimestamps.length > RATE_LIMIT_WS_FRAMES) {
      this.#close(state, connection, 1008, 'RATE_LIMITED')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as { t?: unknown; ts?: unknown; since_seq?: unknown }
    if (frame.t === 'ping') {
      const ts = typeof frame.ts === 'number' ? frame.ts : now
      this.#send(connection, JSON.stringify({ t: 'pong', ts }))
      return
    }
    if (frame.t === 'resume') {
      const since = typeof frame.since_seq === 'number' ? frame.since_seq : null
      this.#resume(state, connection, since)
    }
  }

  #resume(state: TeamState, connection: ConnectionState, since: number | null): void {
    if (since === null || since === 0) {
      this.#resync(connection, 'no_sequence', state)
      return
    }
    if (since > state.sequence) {
      this.#resync(connection, 'sequence_ahead', state)
      return
    }
    const head = state.buffer[0]
    const oldest = head === undefined ? state.sequence + 1 : head.seq
    if (since < oldest - 1) {
      this.#resync(connection, 'sequence_too_old', state)
      return
    }
    for (const frame of state.buffer) {
      if (frame.seq > since) this.#send(connection, this.#eventFrame(frame))
    }
  }

  #resync(connection: ConnectionState, reason: string, state: TeamState): void {
    this.#send(
      connection,
      JSON.stringify({ t: 'resync_required', reason, latest_seq: state.sequence }),
    )
  }

  #eventFrame(frame: StoredFrame): string {
    return JSON.stringify({
      t: 'event',
      seq: frame.seq,
      event: frame.event,
      payload: frame.payload,
      ts: frame.ts,
    })
  }

  #send(connection: ConnectionState, text: string): void {
    if (connection.socket === null) {
      connection.outbox.push(text)
      return
    }
    connection.socket.send(text)
  }

  #close(state: TeamState, connection: ConnectionState, code: number, reason: string): void {
    state.connections.delete(connection.id)
    try {
      connection.socket?.close(code, reason)
    } catch {
      // A socket the peer already closed is not an error worth surfacing.
    }
  }

  async #broadcast(teamId: string, request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return channelError('VALIDATION_FAILED', 'invalid JSON body')
    }
    const events = (body as { events?: unknown }).events
    if (!Array.isArray(events)) return channelError('VALIDATION_FAILED', 'events must be an array')
    const state = this.#teamsState(teamId)
    const published: StoredFrame[] = []
    const now = Date.now()
    for (const raw of events) {
      const entry = raw as Partial<ChannelEvent>
      if (typeof entry.event !== 'string' || entry.event.length === 0) {
        return channelError('VALIDATION_FAILED', 'every event needs a name')
      }
      state.sequence += 1
      const frame: StoredFrame = {
        seq: state.sequence,
        event: entry.event,
        payload: entry.payload ?? {},
        ts: now,
        target_host_id: typeof entry.target_host_id === 'string' ? entry.target_host_id : null,
      }
      state.buffer.push(frame)
      published.push(frame)
    }
    this.#trim(state, now)
    for (const frame of published) this.#fanOut(state, frame)
    return Response.json({ seq: state.sequence })
  }

  /** Section 13: newest 1,000 events and nothing older than one hour. */
  #trim(state: TeamState, now: number): void {
    while (state.buffer.length > EVENT_BUFFER_MAX_EVENTS) state.buffer.shift()
    const cutoff = now - EVENT_BUFFER_WINDOW_MS
    let head = state.buffer[0]
    while (head !== undefined && head.ts < cutoff) {
      state.buffer.shift()
      head = state.buffer[0]
    }
  }

  #fanOut(state: TeamState, frame: StoredFrame): void {
    for (const connection of state.connections.values()) {
      if (frame.target_host_id !== null && connection.hostId !== frame.target_host_id) continue
      this.#send(connection, this.#eventFrame(frame))
    }
  }

  /** Shutdown: tell every socket why it is going away, then drop the state. */
  closeAll(reason = 'server_shutdown'): void {
    for (const state of this.#teams.values()) {
      for (const connection of state.connections.values()) {
        try {
          connection.socket?.close(1001, reason)
        } catch {
          // Peer already gone.
        }
      }
      state.connections.clear()
    }
  }
}
