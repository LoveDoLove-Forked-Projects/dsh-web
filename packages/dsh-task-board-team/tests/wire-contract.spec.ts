/**
 * The wire contract and the collaboration fields the browser renders.
 *
 * Two things are checked here. First, comment authors read as names instead of
 * ids (S5). Second, the frozen samples under `team-hub/contract/` are the
 * authority for the request shapes this provider sends: when a checkout carries
 * them the fake hub validates every Host call against them, so a renamed field on
 * either side fails this suite instead of failing in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareRequest, loadContractSamples } from './support/contract.ts'
import { flush, makeHarness, type Harness } from './support/harness.ts'

let harness: Harness | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  harness?.release()
  harness = undefined
  vi.useRealTimers()
})

/** Claim and start one issue, then return the card id. */
async function claimedCard(current: Harness): Promise<string> {
  current.hub.addIssue({ assigneeAgentId: 'agent_1' })
  await current.service().sweep()
  await flush()
  return current.tasks()[0].id
}

describe('comment authors', () => {
  it('member sees an agent comment attributed to the agent name', async () => {
    // Given a claimed issue whose card is mirrored here
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the hub pushes a comment the bound agent wrote
    harness.hub.push('comment.created', {
      comment: {
        id: 'comm_1',
        issue_id: 'issue_1',
        author_type: 'agent',
        author_agent_id: 'agent_1',
        content: 'migration applied',
        created_at: 1,
      },
    })
    await flush()

    // Then the detail section reads a name, never the hub's agent id
    expect(harness.service().summary().cards[taskId]?.comments[0]?.author).toBe('builder')
  })

  it('member sees a human comment attributed without exposing a member id', async () => {
    // Given a claimed issue whose card is mirrored here
    harness = makeHarness()
    const taskId = await claimedCard(harness)

    // When the hub pushes a comment from a member this Host cannot name
    harness.hub.push('comment.created', {
      comment: {
        id: 'comm_2',
        issue_id: 'issue_1',
        author_type: 'human',
        author_member_id: 'mem_unknown',
        content: 'looks good',
        created_at: 2,
      },
    })
    await flush()

    // Then the author is a readable label rather than a synthetic identifier
    const author = harness.service().summary().cards[taskId]?.comments[0]?.author ?? ''
    expect(author).toBe('team member')
    expect(author.includes('mem_')).toBe(false)
  })
})

describe('frozen wire samples', () => {
  it('operator sees every Host call match the samples this checkout carries', async () => {
    // Given a checkout whose hub side may or may not publish the samples
    const contracts = loadContractSamples()

    // When a full claim, question, comment and settlement flow runs
    harness = makeHarness()
    const taskId = await claimedCard(harness)
    harness.hub.push('comment.created', {
      comment: { id: 'comm_3', issue_id: 'issue_1', author_type: 'agent', author_agent_id: 'agent_1', content: 'x', created_at: 3 },
    })
    await flush()
    harness.board.extensions.emitExecutionSettled({ taskId, executionId: harness.tasks()[0].executions[0].id, outcome: 'succeeded' })
    await flush()

    // Then no call drifted from its sample (an absent directory validates nothing
    // and says so, which is why the assertion also names the sample count)
    expect(harness.hub.contractProblems).toEqual([])
    expect(harness.hub.contract.present).toBe(contracts.present)
  })

  it('operator sees a renamed field caught by the sample comparison', () => {
    // Given a frozen register sample that declares snake_case keys
    const sample = {
      interface: 'hosts.register',
      file: 'register.json',
      method: 'POST',
      path: '/api/v1/teams/:teamId/hosts/register',
      request: { body: { hostname: 'host', client_version: '0.4.12', agents: [{ name: 'builder', preset_id: 'liangshen' }] } },
      response: {},
    }

    // When a client sends the camelCase shape this round exists to remove
    const problems = compareRequest(sample, {
      headers: {},
      query: {},
      method: 'POST',
      path: '/api/v1/teams/team_1/hosts/register',
      body: { hostname: 'host', clientVersion: '0.4.12', agents: [{ name: 'builder', presetId: 'liangshen' }] },
    })

    // Then both renamed fields are named, and nothing else is
    expect(problems).toEqual([
      'hosts.register body.clientVersion is not part of this interface',
      'hosts.register body.client_version is missing',
    ])
  })
})