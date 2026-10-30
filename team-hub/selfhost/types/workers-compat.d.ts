/**
 * Ambient declarations for running the Worker's protocol modules in Node.
 *
 * The HTTP handlers, auth modules and domain modules under team-hub/src are
 * shared verbatim with the Worker: this service does not keep a second copy of
 * the protocol. They are written against the Worker runtime's ambient types, so
 * this file restates the parts they touch in terms the Node build can check.
 * D1 is satisfied structurally by src/db.ts; the Durable Object namespace is
 * satisfied by the in-process channel in src/channel.ts.
 */

interface D1Result<T = unknown> {
  success: true
  meta: { changes: number; last_row_id: number }
  results: T[]
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  all<T = unknown>(): Promise<D1Result<T>>
  run<T = unknown>(): Promise<D1Result<T>>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
}

interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): string
  get(id: string): DurableObjectStub
}

/** Bindings team-hub/src reads from the environment; see src/config.ts. */
interface Env {
  DB: D1Database
  TEAM_CHANNEL: DurableObjectNamespace
}

/** The Durable Object storage surface the shared channel module types against. */
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
}

interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/**
 * The Durable Object base class, only reached through the type-only import of
 * the channel event shape in team-hub/src/durable/team-channel.ts. That class is
 * never instantiated on Node: src/channel.ts is its replacement.
 */
declare module 'cloudflare:workers' {
  export class DurableObject<E = unknown> {
    protected ctx: DurableObjectState
    protected env: E
    constructor(ctx: DurableObjectState, env: E)
    fetch(request: Request): Promise<Response>
  }
}

/** A Worker socket accepts itself; the Node service never uses this path. */
interface WebSocket {
  accept(): void
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

/** Workers allow a 101 response to carry the accepted socket. */
interface ResponseInit {
  webSocket?: unknown
}
