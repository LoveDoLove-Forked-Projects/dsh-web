/**
 * Settlement write-back: what one finished execution tells the hub.
 *
 * The events come through the board's own registry fanout, so the subscription
 * the extension really installed is what these specs drive; the mapping asserted
 * is team-hub/PROTOCOL.md section 5 (a passed automated acceptance becomes
 * \`succeeded\` and moves the issue to \`in_review\`, everything else becomes
 * \`failed\`) plus the section 13 summary cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEAM_EXTENSION_ID, readTaskIssueLink } from '../src/core/identity.ts'
import { EXECUTION_SUMMARY_LIMIT } from '../src/core/hub-protocol.ts'
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

/** Claim and start one issue, then return the card and its open execution id. */
async function claimedCard(current: Harness): Promise<{ taskId: string; executionId: string }> {
  current.hub.addIssue({ assigneeAgentId: 'agent_1' })
  await current.service().sweep()
  await flush()
  const task = current.tasks()[0]
  const execution = task.executions[task.executions.length - 1]
  return { taskId: task.id, executionId: execution.id }
}

describe('settlement write-back', () => {
  it('operator sees a passed execution settle the issue into review', async () => {
    // Given a claimed issue whose execution finished with a pass
    harness = makeHarness()
    const { taskId, executionId } = await claimedCard(harness)

    // When the board reports the settlement
    harness.board.extensions.emitExecutionSettled({ taskId, executionId, outcome: 'succeeded' })
    await flush()

    // Then the hub was told succeeded, under the attempt the card was claimed
    // with, and moved the issue to in_review
    const settle = harness.hub.calls.filter(call => call.path.endsWith('/settle'))
    expect(settle).toHaveLength(1)
    expect((settle[0].body as { outcome: string }).outcome).toBe('succeeded')
    expect((settle[0].body as { execution_attempt_id: string }).execution_attempt_id).toBe('attempt_1')
    expect(harness.hub.issues.get('issue_1')?.status).toBe('in_review')
    expect(readTaskIssueLink(harness.tasks()[0])?.hubStatus).toBe('in_review')
  })

  it('operator sees a failed execution settle the issue as failed with its reason', async () => {
    // Given a claimed issue whose execution failed
    harness = makeHarness()
    const { taskId, executionId } = await claimedCard(harness)

    // When the board reports the failure
    harness.board.extensions.emitExecutionSettled({
      taskId,
      executionId,
      outcome: 'failed',
      error: 'the acceptance command exited 1',
    })
    await flush()

    // Then the hub stored a failed settlement carrying that reason
    const settle = harness.hub.calls.filter(call => call.path.endsWith('/settle'))
    expect((settle[0].body as { outcome: string }).outcome).toBe('failed')
    expect((settle[0].body as { error: string }).error).toBe('the acceptance command exited 1')
    expect(harness.hub.issues.get('issue_1')?.status).toBe('failed')
  })

  it('operator sees a cancelled execution reported as failed rather than as a pass', async () => {
    // Given a claimed issue whose execution was cancelled
    harness = makeHarness()
    const { taskId, executionId } = await claimedCard(harness)

    // When the board reports the cancellation
    harness.board.extensions.emitExecutionSettled({ taskId, executionId, outcome: 'cancelled' })
    await flush()

    // Then the hub was told failed, because a stopped run never earned a review
    const settle = harness.hub.calls.filter(call => call.path.endsWith('/settle'))
    expect((settle[0].body as { outcome: string }).outcome).toBe('failed')
  })

  it('operator sees an oversized summary clipped to the protocol cap', async () => {
    // Given a claimed issue whose failure text is far past the cap
    harness = makeHarness()
    const { taskId, executionId } = await claimedCard(harness)

    // When the settlement carries a very long reason
    harness.board.extensions.emitExecutionSettled({
      taskId,
      executionId,
      outcome: 'failed',
      error: 'x'.repeat(EXECUTION_SUMMARY_LIMIT * 2),
    })
    await flush()

    // Then both the summary and the error respect the cap
    const body = harness.hub.calls.filter(call => call.path.endsWith('/settle'))[0].body as { summary: string; error: string }
    expect(body.summary.length).toBe(EXECUTION_SUMMARY_LIMIT)
    expect(body.error.length).toBe(EXECUTION_SUMMARY_LIMIT)
  })

  it('operator sees a settlement refused once the attempt no longer holds the lease', async () => {
    // Given a claimed issue whose lease lapsed while the run was still going
    harness = makeHarness()
    const { taskId, executionId } = await claimedCard(harness)
    const issue = harness.hub.issues.get('issue_1')
    if (issue === undefined) throw new Error('the fake hub lost the issue')
    issue.leaseToken = undefined
    issue.attemptId = 'attempt_from_another_host'

    // When the settlement arrives for the old attempt
    harness.board.extensions.emitExecutionSettled({ taskId, executionId, outcome: 'succeeded' })
    await flush()

    // Then the hub refused it and the refusal is visible on the card, not silent
    expect(harness.hub.issues.get('issue_1')?.status).not.toBe('in_review')
    expect(String(harness.service().summary().cards[taskId]?.lastError)).toContain('LEASE_EXPIRED')
  })

  it('operator sees a card that mirrors no issue write nothing back', async () => {
    // Given a plain board card created outside this provider
    harness = makeHarness()
    harness.board.apply('plain-card', {
      kind: 'create',
      id: 'plain',
      input: { title: 'Plain', description: '', prompt: 'do it' },
    })

    // When an execution of it settles
    harness.board.extensions.emitExecutionSettled({ taskId: 'plain', executionId: 'exec-x', outcome: 'succeeded' })
    await flush()

    // Then this provider stayed out of it
    expect(harness.hub.calls.filter(call => call.path.endsWith('/settle'))).toHaveLength(0)
    expect(harness.tasks()[0].integrations?.[TEAM_EXTENSION_ID]).toBeUndefined()
  })
})