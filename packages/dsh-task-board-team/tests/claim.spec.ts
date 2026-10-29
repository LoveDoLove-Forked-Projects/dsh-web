/**
 * Claiming: who this Host takes work for, what the mirror card carries, and how a
 * reconnect avoids running the same attempt twice.
 *
 * Everything runs over the real board and the specification-conforming fake hub,
 * so the claim/lease/reconnect rules of team-hub/PROTOCOL.md section 5 are what
 * is being asserted, not a stand-in's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEAM_EXTENSION_ID, readTaskIssueLink } from '../src/core/identity.ts'
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

describe('claiming team issues', () => {
  it('operator sees only the issues of agents bound to this machine claimed', async () => {
    // Given a hub offering one issue for a bound agent and one for another machine
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1', title: 'Ship the thing' })
    harness.hub.addIssue({ id: 'issue_other', assigneeAgentId: 'agent_elsewhere', title: 'Other machine work' })

    // When the provider registers and sweeps
    await harness.service().sweep()

    // Then only the bound agent's issue became a card, and the other one did not
    const tasks = harness.tasks()
    expect(tasks.map(task => task.title)).toEqual(['#1 Ship the thing'])
    expect(readTaskIssueLink(tasks[0])?.issueId).toBe('issue_1')
  })

  it('operator gets a mirror card carrying the issue, attempt and lease identities', async () => {
    // Given a hub with one claimable issue
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1', title: 'Ship the thing', description: 'Body text.' })

    // When the provider sweeps
    await harness.service().sweep()

    // Then the card's payload carries the identities a reconnect needs
    const payload = harness.tasks()[0].integrations?.[TEAM_EXTENSION_ID] as Record<string, unknown>
    expect(payload).toMatchObject({
      issueId: 'issue_1',
      issueNumber: 1,
      attemptId: 'attempt_1',
      leaseToken: 'lease_1',
      agentMemberId: 'mem_builder',
      preset: 'liangshen',
    })
    // And the registered Host speaks the frozen protocol version with its token
    const register = harness.hub.calls.find(call => call.path.endsWith('/hosts/register'))
    expect(register?.protocolVersion).toBe('1.0.0')
    expect(register?.authorization).toBe('Bearer th_host_token')
  })

  it('operator sees the claimed card started once the board accepts the run', async () => {
    // Given a hub with one claimable issue
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })

    // When the provider claims it
    await harness.service().sweep()
    await flush()

    // Then the board really opened an execution session for that card
    expect(harness.creates).toHaveLength(1)
    expect(harness.tasks()[0].status).toBe('running')
  })

  it('operator sees the lease renewed every twenty seconds while the execution runs', async () => {
    // Given a claimed issue whose card is executing
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })
    await harness.service().sweep()
    await flush()
    const before = harness.hub.calls.filter(call => call.path.endsWith('/renew-lease')).length

    // When twenty seconds pass, then forty
    await vi.advanceTimersByTimeAsync(20_000)
    const afterOne = harness.hub.calls.filter(call => call.path.endsWith('/renew-lease')).length
    await vi.advanceTimersByTimeAsync(20_000)
    const afterTwo = harness.hub.calls.filter(call => call.path.endsWith('/renew-lease')).length

    // Then one renewal per cadence reached the hub
    expect(afterOne).toBe(before + 1)
    expect(afterTwo).toBe(before + 2)
  })

  it('operator sees a reconnect re-establish the attempt without a second card or session', async () => {
    // Given a claimed issue already executing in one session
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })
    await harness.service().sweep()
    await flush()
    expect(harness.tasks()).toHaveLength(1)
    expect(harness.creates).toHaveLength(1)

    // When the channel drops, the lease lapses on the hub and the backoff elapses
    harness.hub.drop()
    const claimed = harness.hub.issues.get('issue_1')
    if (claimed === undefined) throw new Error('the fake hub lost the issue')
    claimed.status = 'waiting_host'
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    // Then the same attempt was re-claimed idempotently: one card, one session
    expect(harness.tasks()).toHaveLength(1)
    expect(harness.creates).toHaveLength(1)
    const reclaims = harness.hub.calls.filter(call => call.path.endsWith('/claim') && (call.body as { execution_attempt_id?: string }).execution_attempt_id !== undefined)
    expect(reclaims.length).toBeGreaterThanOrEqual(1)
  })

  it('operator sees the member preset pinned on the mirror card and the card started', async () => {
    // Given a board revision that keeps the draft execution targets
    harness = makeHarness()
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })

    // When the issue is claimed
    await harness.service().sweep()
    await flush()

    // Then the created card carries the member's own preset, and it ran
    const task = harness.tasks()[0]
    expect(task.mode).toBe('liangshen')
    expect(harness.creates).toHaveLength(1)
    expect(harness.service().summary().presetPin).toBe('supported')
  })

  it('operator sees a claimed card left unstarted and flagged when the board cannot pin a preset', async () => {
    // Given a board revision whose create drops the draft execution targets
    harness = makeHarness({ withDraftPreset: false })
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })

    // When the issue is claimed
    await harness.service().sweep()
    await flush()

    // Then nothing ran, the card records why, and the settings summary says it
    const task = harness.tasks()[0]
    expect(task.mode).toBeUndefined()
    expect(harness.creates).toHaveLength(0)
    expect(readTaskIssueLink(task)?.lastError).toContain('cannot pin an agent preset')
    expect(harness.service().summary().presetPin).toBe('missing')
    expect(harness.service().summary().problems.join(' ')).toContain('cannot pin an agent preset')
  })

  it('operator sees a Host that binds no member claim nothing at all', async () => {
    // Given a Host whose bindings resolve to no dsh-agents member
    harness = makeHarness({ agents: [] })
    harness.hub.addIssue({ assigneeAgentId: 'agent_1' })

    // When it starts
    await harness.service().start()

    // Then it never registered and never claimed
    expect(harness.tasks()).toHaveLength(0)
    expect(harness.hub.calls.filter(call => call.path.endsWith('/claim')).length).toBe(0)
    expect(harness.service().summary().problems).toContain('no dsh-agents member is bound to this Host, so no issue is claimed')
  })
})