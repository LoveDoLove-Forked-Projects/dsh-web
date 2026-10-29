import { LEASE_DURATION_MS } from '../constants'
import { fail } from '../errors'
import { publishEvents } from '../channel'
import type { HostPrincipal } from '../auth/session'
import type { AgentRow, IssueRow } from '../types'
import { toIssueView } from '../types'
import { recordActivity } from './activity'
import { findAgent } from './hosts'
import { findIssue, summaryWithinLimit } from './issues'
import { reviewRequestedAlert, sendPush } from '../push/apns'

export interface ClaimResult {
  lease_token: string
  lease_expires_at: number
  execution_attempt_id: string
}

export interface SettlementBody {
  outcome?: string
  summary?: string
  error?: string
  verification_evidence?: unknown
  execution_attempt_id?: string
}

async function boundAgent(env: Env, issue: IssueRow): Promise<AgentRow | null> {
  if (issue.assignee_type !== 'agent' || issue.assignee_agent_id === null) return null
  return findAgent(env, issue.team_id, issue.assignee_agent_id)
}

/** A Host may only act on issues whose assigned agent it owns. */
async function assertHostOwnsIssue(env: Env, host: HostPrincipal, issue: IssueRow): Promise<AgentRow> {
  const agent = await boundAgent(env, issue)
  if (agent === null) {
    fail('HOST_MISMATCH', 'This issue is not assigned to an agent.', { issue_id: issue.id })
  }
  if (agent.host_id !== host.host.id) {
    fail('HOST_MISMATCH', 'The assigned agent belongs to another host.', { issue_id: issue.id })
  }
  return agent
}

/**
 * Section 5 claiming, supplement A4.4: the transition itself is one conditional
 * UPDATE, so two Hosts racing for the same card cannot both win. The two
 * statements below are the two legal shapes of that claim - a fresh claim of a
 * card in assigned or waiting_host, and a reconnect that presents the running
 * attempt's own attempt and lease identifiers - and exactly one of them applies.
 */
export async function claimIssue(
  env: Env,
  teamId: string,
  host: HostPrincipal,
  issueId: string,
  body: { execution_attempt_id?: string; lease_token?: string },
  now: number,
): Promise<ClaimResult> {
  const issue = await findIssue(env, teamId, issueId)
  await assertHostOwnsIssue(env, host, issue)

  const presentedAttempt = body.execution_attempt_id
  const presentedLease = body.lease_token
  const expiresAt = now + LEASE_DURATION_MS
  // A reconnect keeps the attempt it already owns instead of starting a second run.
  const reconnecting =
    presentedAttempt !== undefined &&
    presentedAttempt !== '' &&
    presentedLease !== undefined &&
    presentedLease === issue.lease_token &&
    presentedAttempt === issue.execution_attempt_id
  const leaseToken = reconnecting ? (issue.lease_token as string) : crypto.randomUUID()
  const attemptId = reconnecting
    ? (issue.execution_attempt_id as string)
    : presentedAttempt !== undefined && presentedAttempt !== ''
      ? presentedAttempt
      : crypto.randomUUID()

  const claimed = await env.DB.prepare(
    "UPDATE issues SET status = 'running', lease_token = ?, lease_expires_at = ?, execution_attempt_id = ?, executing_host_id = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status IN ('assigned', 'waiting_host') AND assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)",
  )
    .bind(leaseToken, expiresAt, attemptId, host.host.id, now, issueId, teamId, host.host.id)
    .run()

  if ((claimed.meta.changes ?? 0) === 0) {
    const continued = reconnecting
      ? await env.DB.prepare(
          "UPDATE issues SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status = 'running' AND execution_attempt_id = ? AND lease_token = ? AND assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)",
        )
          .bind(expiresAt, now, issueId, teamId, presentedAttempt, presentedLease, host.host.id)
          .run()
      : null
    if (continued === null || (continued.meta.changes ?? 0) === 0) {
      // The read above may predate a claim that won in the meantime, so the
      // reason is decided from the state the database holds now.
      const current = await findIssue(env, teamId, issueId)
      if (current.status === 'running') {
        fail('LEASE_HELD_BY_OTHER', 'Another execution attempt holds the active lease.', {
          lease_expires_at: current.lease_expires_at,
        })
      }
      fail('INVALID_STATE_TRANSITION', 'The issue is ' + current.status + ' and cannot be claimed.', {
        status: current.status,
      })
    }
    return {
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      execution_attempt_id: attemptId,
    }
  }

  await env.DB.prepare("UPDATE agents SET status = 'busy', updated_at = ? WHERE id = ?")
    .bind(now, issue.assignee_agent_id)
    .run()
  const started = await findIssue(env, teamId, issueId)
  await recordActivity(env, {
    teamId,
    issueId,
    type: 'issue.claimed',
    actor: { kind: 'host', hostId: host.host.id },
    payload: { execution_attempt_id: attemptId, reconnected: reconnecting },
    now,
  })
  await publishEvents(env, teamId, [
    { event: 'issue.claimed', payload: { issue_id: issueId, executing_host_id: host.host.id } },
    {
      event: 'issue.status_changed',
      payload: { issue_id: issueId, old_status: issue.status, new_status: started.status },
    },
    { event: 'issue.updated', payload: { issue: toIssueView(started), changed_fields: ['status', 'lease_expires_at'] } },
  ])
  return { lease_token: leaseToken, lease_expires_at: expiresAt, execution_attempt_id: attemptId }
}

/** Section 5 renewal: extend an unexpired lease by one lease duration. */
export async function renewLease(
  env: Env,
  teamId: string,
  host: HostPrincipal,
  issueId: string,
  leaseToken: string,
  now: number,
): Promise<{ lease_expires_at: number }> {
  const issue = await findIssue(env, teamId, issueId)
  await assertHostOwnsIssue(env, host, issue)
  if (issue.status !== 'running' || issue.executing_host_id !== host.host.id) {
    fail('LEASE_EXPIRED', 'The issue is not running under this host.', { status: issue.status })
  }
  if (issue.lease_token === null || issue.lease_token !== leaseToken) {
    fail('LEASE_EXPIRED', 'The lease token does not match the active lease.')
  }
  if (issue.lease_expires_at === null || issue.lease_expires_at <= now) {
    await expireLease(env, issue, now)
    fail('LEASE_EXPIRED', 'The lease expired before this renewal.', { issue_id: issue.id })
  }
  const expiresAt = now + LEASE_DURATION_MS
  await env.DB.prepare('UPDATE issues SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
    .bind(expiresAt, now, issue.id)
    .run()
  return { lease_expires_at: expiresAt }
}

/** Section 5 settlement write-back: success enters in_review, failure enters failed. */
export async function settleIssue(
  env: Env,
  teamId: string,
  host: HostPrincipal,
  issueId: string,
  body: SettlementBody,
  now: number,
): Promise<{ ok: true; status: string }> {
  const issue = await findIssue(env, teamId, issueId)
  await assertHostOwnsIssue(env, host, issue)
  if (body.outcome !== 'succeeded' && body.outcome !== 'failed') {
    fail('VALIDATION_FAILED', "outcome must be 'succeeded' or 'failed'.", { field: 'outcome' })
  }
  const summary = summaryWithinLimit(body.summary)
  const attemptMatches =
    body.execution_attempt_id !== undefined && body.execution_attempt_id === issue.execution_attempt_id

  if (issue.status === 'in_review' || issue.status === 'failed') {
    if (body.execution_attempt_id === undefined || attemptMatches) {
      return { ok: true, status: issue.status }
    }
    fail('INVALID_STATE_TRANSITION', 'The issue already settled under a different attempt.', { status: issue.status })
  }
  const reconnectWriteBack = issue.status === 'waiting_host' && attemptMatches
  if (issue.status !== 'running' && !reconnectWriteBack) {
    fail('LEASE_EXPIRED', 'The issue is not running.', { status: issue.status })
  }
  const leaseExpired = issue.lease_expires_at !== null && issue.lease_expires_at <= now
  if (leaseExpired && !attemptMatches) {
    await expireLease(env, issue, now)
    fail('LEASE_EXPIRED', 'The lease expired before settlement.')
  }
  if (issue.executing_host_id !== null && issue.executing_host_id !== host.host.id) {
    fail('HOST_MISMATCH', 'Another host is executing this issue.', { issue_id: issue.id })
  }

  const nextStatus = body.outcome === 'succeeded' ? 'in_review' : 'failed'
  await env.DB.prepare(
    'UPDATE issues SET status = ?, execution_summary = ?, failure_error = ?, lease_token = NULL, lease_expires_at = NULL, rework_instructions = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(
      nextStatus,
      summary,
      body.outcome === 'failed' ? (body.error ?? 'execution failed') : null,
      now,
      issue.id,
    )
    .run()
  await env.DB.prepare("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?")
    .bind(now, issue.assignee_agent_id)
    .run()
  const settled = await findIssue(env, teamId, issueId)
  await recordActivity(env, {
    teamId,
    issueId,
    type: body.outcome === 'succeeded' ? 'issue.settled_in_review' : 'issue.failed',
    actor: { kind: 'host', hostId: host.host.id },
    payload: {
      execution_attempt_id: issue.execution_attempt_id,
      summary,
      error: body.error ?? null,
      verification_evidence: body.verification_evidence ?? null,
    },
    now,
  })
  await publishEvents(env, teamId, [
    {
      event: 'issue.status_changed',
      payload: { issue_id: issueId, old_status: issue.status, new_status: nextStatus },
    },
    { event: 'issue.updated', payload: { issue: toIssueView(settled), changed_fields: ['status', 'execution_summary'] } },
  ])
  if (nextStatus === 'in_review' && settled.reviewer_member_id !== null) {
    await sendPush(
      env,
      [settled.reviewer_member_id],
      {
        teamId,
        issueId: settled.id,
        eventType: 'review_requested',
        body: reviewRequestedAlert(settled.issue_number, settled.title),
      },
      now,
    )
  }
  return { ok: true, status: nextStatus }
}

/**
 * Section 4: a running issue whose lease lapsed, or whose Host went offline,
 * returns to waiting_host. It is never handed to another Host: the assignee
 * agent, and therefore the only Host allowed to claim it, does not change.
 */
export async function expireLease(env: Env, issue: IssueRow, now: number, reason = 'lease_expired'): Promise<void> {
  await env.DB.prepare("UPDATE issues SET status = 'waiting_host', updated_at = ? WHERE id = ?").bind(now, issue.id).run()
  if (issue.assignee_agent_id !== null) {
    await env.DB.prepare("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?").bind(now, issue.assignee_agent_id).run()
  }
  const waiting = await env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(issue.id).first<IssueRow>()
  await recordActivity(env, {
    teamId: issue.team_id,
    issueId: issue.id,
    type: 'issue.host_offline',
    actor: { kind: 'system' },
    payload: { reason, execution_attempt_id: issue.execution_attempt_id },
    now,
  })
  if (waiting !== null) {
    await publishEvents(env, issue.team_id, [
      { event: 'issue.status_changed', payload: { issue_id: issue.id, old_status: 'running', new_status: 'waiting_host' } },
      { event: 'issue.updated', payload: { issue: toIssueView(waiting), changed_fields: ['status'] } },
    ])
  }
}

/** Every running issue of the team whose lease has lapsed. */
export async function sweepExpiredLeases(env: Env, teamId: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM issues WHERE team_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
  )
    .bind(teamId, now)
    .all<IssueRow>()
  for (const issue of results) await expireLease(env, issue, now)
  return results.length
}

/** Running issues of a host that just went offline (3 missed heartbeats). */
export async function sweepHostRunningIssues(env: Env, teamId: string, hostId: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT * FROM issues WHERE team_id = ? AND status = 'running' AND executing_host_id = ?")
    .bind(teamId, hostId)
    .all<IssueRow>()
  for (const issue of results) await expireLease(env, issue, now, 'host_offline')
  return results.length
}
/** Section 4: an assigned agent card whose host is not online waits for it. */
export async function sweepAssignedAwaitingHost(env: Env, teamId: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT i.* FROM issues i JOIN agents a ON a.id = i.assignee_agent_id JOIN hosts h ON h.id = a.host_id WHERE i.team_id = ? AND i.status = 'assigned' AND h.status != 'online'",
  )
    .bind(teamId)
    .all<IssueRow>()
  for (const issue of results) {
    await env.DB.prepare("UPDATE issues SET status = 'waiting_host', updated_at = ? WHERE id = ?").bind(now, issue.id).run()
    const waiting = await env.DB.prepare('SELECT * FROM issues WHERE id = ?').bind(issue.id).first<IssueRow>()
    await recordActivity(env, {
      teamId,
      issueId: issue.id,
      type: 'issue.waiting_host',
      actor: { kind: 'system' },
      payload: { reason: 'host_offline' },
      now,
    })
    if (waiting !== null) {
      await publishEvents(env, teamId, [
        { event: 'issue.status_changed', payload: { issue_id: issue.id, old_status: 'assigned', new_status: 'waiting_host' } },
        { event: 'issue.updated', payload: { issue: toIssueView(waiting), changed_fields: ['status'] } },
      ])
    }
  }
  return results.length
}