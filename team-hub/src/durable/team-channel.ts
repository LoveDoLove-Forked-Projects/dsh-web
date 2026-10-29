import { DurableObject } from 'cloudflare:workers'
import {
  EVENT_BUFFER_MAX_EVENTS,
  EVENT_BUFFER_WINDOW_MS,
  RATE_LIMIT_WS_FRAMES,
  RATE_LIMIT_WINDOW_MS,
  WS_FRAME_LIMIT_BYTES,
} from '../constants'

/** One mutation a caller asks the channel to publish (PROTOCOL.md section 9). */
export interface ChannelEvent {
  /** Event name from the section 9 event table, for example `issue.claimed`. */
  event: string
  /** Event-specific payload, broadcast verbatim. */
  payload: unknown
  /** When set, only the socket belonging to this Host receives the event. */
  target_host_id?: string | null
}

interface StoredFrame {
  seq: number
  event: string
  payload: unknown
  ts: number
  target_host_id: string | null
}

interface ConnectionState {
  hostId: string | null
  frameTimestamps: number[]
}

const SEQUENCE_KEY = 'seq'
const BUFFER_KEY = 'buffer'
const WS_PATH = '/ws'
const BROADCAST_PATH = '/broadcast'
const STATE_PATH = '/state'

/**
 * One instance per team: the authority for the team's monotonic event
 * sequence, its replay buffer and its connected sockets (PROTOCOL.md section
 * 9). The sequence and the buffer live in Durable Object storage so a resumed
 * client keeps receiving events after the instance is evicted; sockets are
 * per-instance by nature and simply belong to the current instance.
 */
export class TeamChannelDO extends DurableObject<Env> {
  #sequence = 0
  #buffer: StoredFrame[] = []
  readonly #connections = new Map<WebSocket, ConnectionState>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.#sequence = (await ctx.storage.get<number>(SEQUENCE_KEY)) ?? 0
      this.#buffer = (await ctx.storage.get<StoredFrame[]>(BUFFER_KEY)) ?? []
    })
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === WS_PATH) return this.#upgrade(request, url)
    if (url.pathname === BROADCAST_PATH) return this.#publish(request)
    if (url.pathname === STATE_PATH) {
      const head = this.#buffer[0]
      return Response.json({
        latest_seq: this.#sequence,
        oldest_seq: head === undefined ? null : head.seq,
        connections: this.#connections.size,
      })
    }
    return new Response('unknown channel route', { status: 404 })
  }

  #upgrade(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ error: { code: 'VALIDATION_FAILED', message: 'expected a WebSocket upgrade' } }, { status: 400 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()
    this.#connections.set(server, { hostId: request.headers.get('x-team-channel-host-id'), frameTimestamps: [] })
    server.addEventListener('message', (event) => this.#onFrame(server, event.data))
    server.addEventListener('close', () => this.#connections.delete(server))
    server.addEventListener('error', () => this.#connections.delete(server))

    const sinceParam = url.searchParams.get('since_seq')
    const since = sinceParam === null ? null : Number.parseInt(sinceParam, 10)
    this.#resume(server, Number.isFinite(since) ? since : null)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Section 9 resumption rules: replay what the buffer still holds, and tell
   * the client to re-fetch the full snapshot when it cannot.
   */
  #resume(server: WebSocket, since: number | null): void {
    if (since === null || since === 0) {
      this.#sendResync(server, 'no_sequence')
      return
    }
    if (since > this.#sequence) {
      this.#sendResync(server, 'sequence_ahead')
      return
    }
    const head = this.#buffer[0]
    const oldest = head === undefined ? this.#sequence + 1 : head.seq
    if (since < oldest - 1) {
      this.#sendResync(server, 'sequence_too_old')
      return
    }
    for (const frame of this.#buffer) {
      if (frame.seq > since) this.#sendEvent(server, frame)
    }
  }

  #sendResync(server: WebSocket, reason: string): void {
    server.send(JSON.stringify({ t: 'resync_required', reason, latest_seq: this.#sequence }))
  }

  #sendEvent(server: WebSocket, frame: StoredFrame): void {
    server.send(JSON.stringify({ t: 'event', seq: frame.seq, event: frame.event, payload: frame.payload, ts: frame.ts }))
  }

  #onFrame(server: WebSocket, data: unknown): void {
    const state = this.#connections.get(server)
    if (!state) return
    if (typeof data !== 'string') {
      this.#close(server, 1003, 'text_frames_only')
      return
    }
    if (new TextEncoder().encode(data).byteLength > WS_FRAME_LIMIT_BYTES) {
      this.#close(server, 1009, 'PAYLOAD_TOO_LARGE')
      return
    }
    const now = Date.now()
    state.frameTimestamps = state.frameTimestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
    state.frameTimestamps.push(now)
    if (state.frameTimestamps.length > RATE_LIMIT_WS_FRAMES) {
      this.#close(server, 1008, 'RATE_LIMITED')
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
      server.send(JSON.stringify({ t: 'pong', ts }))
      return
    }
    if (frame.t === 'resume') {
      const since = typeof frame.since_seq === 'number' ? frame.since_seq : null
      this.#resume(server, since)
    }
  }

  #close(server: WebSocket, code: number, reason: string): void {
    this.#connections.delete(server)
    try {
      server.close(code, reason)
    } catch {
      // A socket the peer already closed is not an error worth surfacing.
    }
  }

  /** Append events, assign their sequence numbers, persist, then fan out. */
  async #publish(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: { code: 'VALIDATION_FAILED', message: 'invalid JSON body' } }, { status: 400 })
    }
    const events = (body as { events?: unknown }).events
    if (!Array.isArray(events)) {
      return Response.json({ error: { code: 'VALIDATION_FAILED', message: 'events must be an array' } }, { status: 400 })
    }
    const published: StoredFrame[] = []
    const now = Date.now()
    for (const raw of events) {
      const entry = raw as Partial<ChannelEvent>
      if (typeof entry.event !== 'string' || entry.event.length === 0) {
        return Response.json({ error: { code: 'VALIDATION_FAILED', message: 'every event needs a name' } }, { status: 400 })
      }
      this.#sequence += 1
      const frame: StoredFrame = {
        seq: this.#sequence,
        event: entry.event,
        payload: entry.payload ?? {},
        ts: now,
        target_host_id: typeof entry.target_host_id === 'string' ? entry.target_host_id : null,
      }
      this.#buffer.push(frame)
      published.push(frame)
    }
    this.#trim(now)
    await this.ctx.storage.put({ [SEQUENCE_KEY]: this.#sequence, [BUFFER_KEY]: this.#buffer })
    for (const frame of published) this.#fanOut(frame)
    return Response.json({ seq: this.#sequence })
  }

  /** Both bounds of section 13 apply: newest 1,000 events, nothing older than 1 hour. */
  #trim(now: number): void {
    while (this.#buffer.length > EVENT_BUFFER_MAX_EVENTS) this.#buffer.shift()
    const cutoff = now - EVENT_BUFFER_WINDOW_MS
    let head = this.#buffer[0]
    while (head !== undefined && head.ts < cutoff) {
      this.#buffer.shift()
      head = this.#buffer[0]
    }
  }

  #fanOut(frame: StoredFrame): void {
    for (const [socket, state] of this.#connections) {
      if (frame.target_host_id !== null && state.hostId !== frame.target_host_id) continue
      this.#sendEvent(socket, frame)
    }
  }
}
