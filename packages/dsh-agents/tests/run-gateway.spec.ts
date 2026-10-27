/**
 * The run seam's one wire contract: the `session.create` body.
 *
 * A squad that pins no workspace must reach the Host as a request that carries
 * no workspaceId key at all. An explicit `undefined` or an empty string would be
 * a statement about a workspace rather than the absence of a pin, and a body with
 * the key present is what makes a Host compose the session somewhere the user
 * never chose.
 */
import { describe, expect, it } from 'vitest'
import { createHostRunGateway, type TypertGatewayFace } from '../src/host/run-gateway.ts'

interface Recorded {
  namespace: string
  method: string
  args: Record<string, unknown>
}

/** A typert gateway that records every invocation and answers one session id. */
function recordingGateway(): { calls: Recorded[]; face: TypertGatewayFace } {
  const calls: Recorded[] = []
  const face: TypertGatewayFace = {
    async invoke(request) {
      calls.push({ namespace: request.namespace, method: request.method, args: request.args })
      return { sessionId: 'session-1' }
    },
  }
  return { calls, face }
}

describe('the session.create request a run sends', () => {
  it('operator runs an unbound squad and the request carries no workspaceId key', async () => {
    // Given a run with no workspace pin, When the gateway creates the session, Then the request body has no workspaceId key at all.
    const { calls, face } = recordingGateway()
    const gateway = createHostRunGateway({ gateway: face })

    expect(await gateway.createSession({})).toEqual({ sessionId: 'session-1' })
    expect(calls.map(call => call.namespace + '/' + call.method)).toEqual(['session/create'])
    const body = calls[0]?.args.request as Record<string, unknown>
    expect(body).toEqual({})
    expect(Object.keys(body)).toEqual([])
  })

  it('operator runs a squad pinned to a workspace and the request carries exactly that pin', async () => {
    // Given a validated pin, When the gateway creates the session, Then the request body names that workspace and nothing else.
    const { calls, face } = recordingGateway()
    const gateway = createHostRunGateway({ gateway: face })

    await gateway.createSession({ workspaceId: 'ws-1' })
    expect(calls[0]?.args).toEqual({ request: { workspaceId: 'ws-1' } })
  })
})
