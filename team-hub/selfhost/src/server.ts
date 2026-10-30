import { STATUS_CODES, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { Hono } from 'hono'
import { PROTOCOL_VERSION, WS_FRAME_LIMIT_BYTES } from '../../src/constants'
import { HubError, errorBody } from '../../src/errors'
import { json } from '../../src/http'
import { handleRequest } from '../../src/router'
import type { OutboundTransport } from '../../src/outbound'
import type { SweepResult } from '../../src/domain/sweep'
import { TeamChannels, upgradePlans } from './channel'
import { envValues, type HubConfig } from './config'
import { openDatabase, type OpenedDatabase } from './db'
import { applyMigrations, migrationStatus } from './migrations'
import { createSweeper, type Sweeper } from './scheduler'

/**
 * The Node entry point: Hono serves the two health routes and hands every
 * protocol route to the same router the Worker uses, so paths, bodies, error
 * codes and the lease state machine cannot drift between the two runtimes.
 *
 * TLS is terminated by a reverse proxy; this server speaks plain HTTP and
 * listens on the loopback address by default. The request URL is reconstructed
 * from Host and X-Forwarded-Proto, which keeps absolute redirect URIs and the
 * OAuth origin check working behind that proxy.
 */

export interface HubOptions {
  config: HubConfig
  /** Test seam shared with the Worker: an injected GitHub/APNs/account service. */
  outbound?: OutboundTransport
  startedAt?: number
  log?: (message: string) => void
}

export interface Hub {
  env: Env
  config: HubConfig
  app: Hono
  server: Server
  channel: TeamChannels
  database: OpenedDatabase
  /** Public base URL, known after listen(). */
  origin: string
  listen(): Promise<{ host: string; port: number; url: string }>
  /** Run the Worker cron's sweep now. */
  sweep(): Promise<SweepResult>
  close(): Promise<void>
}

const BODY_LIMIT_BYTES = 1024 * 1024
const GITHUB_ROUTES = new Set(['/auth/github/authorize', '/auth/github/callback', '/auth/token'])

class BodyTooLarge extends Error {}

function buildEnv(config: HubConfig, database: OpenedDatabase, channel: TeamChannels, outbound?: OutboundTransport): Env {
  const env: Record<string, unknown> = {
    DB: database.d1,
    TEAM_CHANNEL: channel.namespace,
    ...envValues(config),
  }
  // The Worker reads this optional seam from its environment; keeping the same
  // field is what lets one fake serve both test suites.
  if (outbound !== undefined) env.TEAM_HUB_OUTBOUND = outbound
  return env as unknown as Env
}

function featureFlags(config: HubConfig): Record<string, boolean> {
  return {
    github_login: config.github !== null,
    account_sign_in: config.account !== null,
    push: config.apns !== null,
    bootstrap: config.bootstrapToken !== null,
  }
}

export function createApp(
  env: Env,
  context: {
    config: HubConfig
    database: OpenedDatabase
    startedAt: number
    log?: (message: string) => void
  },
): Hono {
  const app = new Hono()
  const { config, database, startedAt } = context

  // Liveness: the process answers, nothing else is claimed.
  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      service: 'dsh-team-hub-selfhost',
      protocol_version: PROTOCOL_VERSION,
      uptime_ms: Date.now() - startedAt,
    }),
  )

  // Readiness: the database answers and the schema on disk is fully applied.
  app.get('/readyz', (c) => {
    let databaseOk = false
    let applied = 0
    let pending: string[] = []
    try {
      databaseOk = database.d1.probe()
      const status = migrationStatus(database.sqlite, config.migrationsDir)
      applied = status.applied.length
      pending = status.pending
    } catch {
      databaseOk = false
    }
    const ready = databaseOk && pending.length === 0
    return c.json(
      {
        status: ready ? 'ready' : 'not_ready',
        database: databaseOk ? 'ok' : 'unavailable',
        migrations: { applied, pending },
        features: featureFlags(config),
      },
      ready ? 200 : 503,
    )
  })

  app.all('*', async (c) => {
    const path = c.req.path
    // The Worker starts with these settings absent and fails at GitHub. A
    // self-hosted deployment states the closed route in its startup report, and
    // the route itself answers NOT_CONFIGURED instead of redirecting to GitHub
    // with an empty client id.
    if (GITHUB_ROUTES.has(path) && config.github === null) {
      return json(
        errorBody(
          new HubError(
            'NOT_CONFIGURED',
            'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured on this hub.',
          ),
        ),
        503,
      )
    }
    try {
      return await handleRequest(c.req.raw, env)
    } catch (error) {
      context.log?.(String(error))
      return json(errorBody(new HubError('INTERNAL_ERROR', 'Unhandled internal error.')), 500)
    }
  })

  return app
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(', ') : value
}

function requestUrl(request: IncomingMessage): string {
  const forwarded = headerValue(request, 'x-forwarded-proto')
  const protocol = (forwarded ?? 'http').split(',')[0]?.trim() || 'http'
  const host = headerValue(request, 'host') ?? 'localhost'
  return protocol + '://' + host + (request.url ?? '/')
}

function toWebRequest(request: IncomingMessage, body: Buffer | undefined): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const method = (request.method ?? 'GET').toUpperCase()
  const init: RequestInit = { method, headers }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = body as Uint8Array
  return new Request(requestUrl(request), init)
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > BODY_LIMIT_BYTES) throw new BodyTooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: string[] = []
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return
    headers.push(name, value)
  })
  for (const cookie of cookies) headers.push('set-cookie', cookie)
  const bodyless = response.status === 204 || response.status === 304
  const body = bodyless ? null : Buffer.from(await response.arrayBuffer())
  if (body !== null) headers.push('content-length', String(body.length))
  res.writeHead(response.status, headers)
  res.end(body ?? undefined)
}

/** Write a plain HTTP response onto a socket the server already detached. */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer())
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? 'Unknown'}`]
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return
    lines.push(name + ': ' + value)
  })
  for (const cookie of cookies) lines.push('set-cookie: ' + cookie)
  lines.push('content-length: ' + body.length, 'connection: close', '', '')
  socket.write(lines.join('\r\n'))
  socket.write(body)
  socket.end()
}

export async function createHub(options: HubOptions): Promise<Hub> {
  const { config } = options
  const log = options.log ?? ((message: string) => console.log(message))
  const database = openDatabase(config.databasePath)
  const migrations = applyMigrations(database.sqlite, config.migrationsDir)
  if (migrations.newlyApplied.length > 0) {
    log('[migrate] applied ' + migrations.newlyApplied.join(', '))
  }
  const channel = new TeamChannels()
  const env = buildEnv(config, database, channel, options.outbound)
  const app = createApp(env, {
    config,
    database,
    startedAt: options.startedAt ?? Date.now(),
    log,
  })
  const sweeper: Sweeper = createSweeper(env, { intervalMs: config.sweepIntervalMs, log })

  const server = createServer((request, res) => {
    void (async () => {
      let body: Buffer | undefined
      try {
        body = await readBody(request)
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          await sendResponse(
            json(errorBody(new HubError('PAYLOAD_TOO_LARGE', 'Request body exceeds ' + BODY_LIMIT_BYTES + ' bytes.')), 413),
            res,
          )
          request.destroy()
          return
        }
        throw error
      }
      const response = await app.fetch(toWebRequest(request, body))
      await sendResponse(response, res)
    })().catch((error: unknown) => {
      log('[http] ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(errorBody(new HubError('INTERNAL_ERROR', 'Unhandled internal error.'))))
      } else {
        res.end()
      }
    })
  })

  // One byte above the section 11 cap, so a frame of exactly the cap reaches
  // onFrame() and is closed with the protocol's own reason string; anything
  // larger is cut by ws itself.
  server.on('error', (error: Error) => {
    log('[http] server error: ' + error.message)
  })

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: WS_FRAME_LIMIT_BYTES + 1,
  })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const response = await app.fetch(toWebRequest(request, undefined))
      const plan = upgradePlans.get(response)
      if (plan === undefined) {
        await writeRawResponse(socket, response)
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        channel.attach(plan, {
          send: (data: string) => {
            if (ws.readyState === ws.OPEN) ws.send(data)
          },
          close: (code: number, reason: string) => ws.close(code, reason),
        })
        ws.on('message', (data: unknown, isBinary: boolean) => {
          const text = isBinary ? '' : Buffer.from(data as Buffer).toString('utf8')
          channel.onFrame(plan, text, isBinary)
        })
        ws.on('close', () => channel.detach(plan))
        ws.on('error', () => channel.detach(plan))
      })
    })().catch((error: unknown) => {
      log('[ws] upgrade failed: ' + (error instanceof Error ? error.message : String(error)))
      socket.destroy()
    })
  })

  let origin = 'http://' + config.host + ':' + config.port
  let listening = false
  let closed = false

  return {
    env,
    config,
    app,
    server,
    channel,
    database,
    get origin() {
      return origin
    },
    async listen() {
      if (listening) return { host: config.host, port: config.port, url: origin }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(config.port, config.host, () => {
          server.off('error', onError)
          resolve()
        })
      })
      listening = true
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : config.port
      origin = 'http://' + (config.host.includes(':') ? '[' + config.host + ']' : config.host) + ':' + port
      // Section 5/6 sweep: once before the port takes traffic, then on the
      // Worker's one-minute cadence.
      await sweeper.runOnce()
      sweeper.start()
      return { host: config.host, port, url: origin }
    },
    async sweep() {
      return sweeper.runOnce()
    },
    async close() {
      if (closed) return
      closed = true
      sweeper.stop()
      channel.closeAll()
      wss.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      database.close()
    },
  }
}
