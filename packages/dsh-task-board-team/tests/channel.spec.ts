/**
 * The team channel handshake against a real upgrade listener.
 *
 * The hub authenticates a Host channel only through the upgrade's Authorization
 * header and refuses a token in the URL, so the platform socket is driven
 * against a local HTTP server and the request it actually sends is inspected.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { platformSocket, teamSocketHeaders, teamSocketUrl } from '../src/host/channel.ts'

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
  server = undefined
})

/** Start a listener that records the first upgrade request and drops the socket. */
async function upgradeListener(): Promise<{ port: number, upgrade: Promise<IncomingMessage> }> {
  let received: (request: IncomingMessage) => void = () => {}
  const upgrade = new Promise<IncomingMessage>(resolve => { received = resolve })
  server = createServer()
  server.on('upgrade', (request, socket) => {
    received(request)
    socket.destroy()
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  return { port: (server.address() as AddressInfo).port, upgrade }
}

describe('team channel handshake', () => {
  it('operator sees the Host Token presented in the upgrade header and never in the URL', async () => {
    // Given a hub listener and a configured hub URL
    const { port, upgrade } = await upgradeListener()
    const url = teamSocketUrl('http://127.0.0.1:' + String(port) + '/', 'team_1', 7)

    // When the platform socket opens the team channel with the Host Token
    const socket = platformSocket(url, { message() {}, closed() {} }, teamSocketHeaders('th_host_secret'))
    const request = await upgrade
    socket.close()

    // Then the token rides the Authorization header, the URL carries only the cursor and version
    expect(request.headers.authorization).toBe('Bearer th_host_secret')
    expect(request.headers['x-team-hub-protocol-version']).toBe('1.0.0')
    expect(request.url).toBe('/api/v1/teams/team_1/ws?since_seq=7&protocol_version=1.0.0')
    expect(request.url).not.toContain('th_host_secret')
  })
})
