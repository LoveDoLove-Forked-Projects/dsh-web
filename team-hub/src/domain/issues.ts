import {
  EXECUTION_SUMMARY_LIMIT,
  ISSUE_DESCRIPTION_LIMIT_BYTES,
  ISSUE_TITLE_LIMIT,
  type IssueStatus,
} from '../constants'
import { fail } from '../errors'
import { newId } from '../ids'
import { publishEvents } from '../channel'
import { assignedAlert, reviewRequestedAlert, sendPush } from '../push/apns'
import type { MemberPrincipal } from '../auth/session'
import type { AgentRow, IssueRow, MemberRow } from '../types'
import { toIssueView } from '../types'
import type { ChannelEvent } from '../durable/team-channel'
import { recordActivity } from './activity'
import { findAgent } from './hosts'

const ACTIVE_STATUSES: IssueStatus[] = ['todo', 'assigned', 'waiting_host', 'running', 'in_review']
const ALL_STATUSES: IssueStatus[] = [...ACTIVE_STATUSES, 'done', 'canceled', 'failed']

export function isIssueStatus(value: string): value is IssueStatus {
  return (ALL_STATUSES as string[]).includes(value)
}

export interface CreateIssueBody {
  title: string
  description?: string
  assignee_type?: 'member' | 'agent'
  assignee_id?: string
  reviewer_member_id?: string
}

export interface PatchIssueBody {
  title?: string
  description?: string
  assignee_type?: 'member' | 'agent'
  assignee_id?: string
  reviewer_member_id?: string
  status?: string
}

export async function findIssue(env: Env, teamId: string, issueId: string): Promise<IssueRow> {
  const issue = await env.DB.prepare('SELECT * FROM issues WHERE id = ? AND team_id = ?')
    .bind(issueId, teamId)
    .first<IssueRow>()
  if (!issue) fail('ISSUE_NOT_FOUND', 'Issue not found on this team.', { issue_id: issueId })
  return issue
}

export async function findMember(env: Env, teamId: string, memberId: string): Promise<MemberRow | null> {
  return env.DB.prepare('SELECT * FROM members WHERE id = ? AND team_id = ?').bind(memberId, teamId).first<MemberRow>()
}

/** Whether the host an agent is bound to currently counts as online. */
export async function agentHostOnline(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS online FROM agents a JOIN hosts h ON h.id = a.host_id WHERE a.id = ? AND h.status = 'online' LIMIT 1",
  )
    .bind(agentId)
    .first<{ online: number }>()
  return row !== null
}

export async function hostOfAgent(env: Env, agentId: string): Promise<AgentRow | null> {
  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).first<AgentRow>()
  return agent ?? null
}

async function nextIssueNumber(env: Env, teamId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM issues WHERE team_id = ?')
    .bind(teamId)
    .first<{ next: number }>()
  return row?.next ?? 1
}

async function updateIssueRow(env: Env, issueId: string, patch: Record<string, string | number | null>): Promise<void> {
  const entries = Object.entries(patch)
  if (entries.length === 0) return
  const assignments = entries.map(([key]) => key + ' = ?').join(', ')
  await env.DB.prepare('UPDATE issues SET ' + assignments + ' WHERE id = ?')
    .bind(...entries.map(([, value]) => value), issueId)
    .run()
}

async function validateAssignee(
  env: Env,
  teamId: string,
  type: 'member' | 'agent',
  assigneeId: string,
): Promise<{ memberId: string | null; agentId: string | null }> {
  if (type === 'member') {
    const member = await findMember(env, teamId, assigneeId)
    if (!member || member.status === 'suspended') {
      fail('VALIDATION_FAILED', 'assignee_id is not an active member of this team.', { field: 'assignee_id' })
    }
    return { memberId: member.id, agentId: null }
  }
  const agent = await findAgent(env, teamId, assigneeId)
  if (!agent) fail('VALIDATION_FAILED', 'assignee_id is not an agent of this team.', { field: 'assignee_id' })
  return { memberId: null, agentId: agent.id }
}

export async function createIssue(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  body: CreateIssueBody,
  now: number,
): Promise<IssueRow> {
  const title = body.title
  if ([...title].length > ISSUE_TITLE_LIMIT) {
    fail('VALIDATION_FAILED', 'title exceeds ' + ISSUE_TITLE_LIMIT + ' characters.', { limit_chars: ISSUE_TITLE_LIMIT })
  }
  const description = body.description ?? ''
  if (new TextEncoder().encode(description).length > ISSUE_DESCRIPTION_LIMIT_BYTES) {
    fail('VALIDATION_FAILED', 'description exceeds ' + ISSUE_DESCRIPTION_LIMIT_BYTES + ' bytes.', {
      limit_bytes: ISSUE_DESCRIPTION_LIMIT_BYTES,
    })
  }

  let assigneeType: 'member' | 'agent' | null = null
  let assigneeMemberId: string | null = null
  let assigneeAgentId: string | null = null
  if (body.assignee_type !== undefined) {
    if (body.assignee_type !== 'member' && body.assignee_type !== 'agent') {
      fail('VALIDATION_FAILED', "assignee_type must be 'member' or 'agent'.", { field: 'assignee_type' })
    }
    if (body.assignee_id === undefined || body.assignee_id === '') {
      fail('VALIDATION_FAILED', 'assignee_id is required when assignee_type is set.', { field: 'assignee_id' })
    }
    assigneeType = body.assignee_type
    const resolved = await validateAssignee(env, teamId, assigneeType, body.assignee_id)
    assigneeMemberId = resolved.memberId
    assigneeAgentId = resolved.agentId
  }

  let reviewerMemberId: string | null = null
  if (body.reviewer_member_id !== undefined && body.reviewer_member_id !== '') {
    const reviewer = await findMember(env, teamId, body.reviewer_member_id)
    if (!reviewer) {
      fail('VALIDATION_FAILED', 'reviewer_member_id is not a member of this team.', { field: 'reviewer_member_id' })
    }
    reviewerMemberId = reviewer.id
  }
  // Section 13 default reviewer: an agent-executed issue always has a human
  // reviewer, and the creator is the default.
  if (assigneeType === 'agent' && reviewerMemberId === null) reviewerMemberId = actor.member.id

  let status: IssueStatus = 'todo'
  if (assigneeType === 'member') status = 'assigned'
  if (assigneeType === 'agent' && assigneeAgentId !== null) {
    status = (await agentHostOnline(env, assigneeAgentId)) ? 'assigned' : 'waiting_host'
  }

  const row: IssueRow = {
    id: newId('issue', now),
    team_id: teamId,
    issue_number: await nextIssueNumber(env, teamId),
    title,
    description,
    status,
    creator_member_id: actor.member.id,
    assignee_type: assigneeType,
    assignee_member_id: assigneeMemberId,
    assignee_agent_id: assigneeAgentId,
    reviewer_member_id: reviewerMemberId,
    executing_host_id: null,
    lease_token: null,
    lease_expires_at: null,
    execution_attempt_id: null,
    execution_summary: null,
    rework_instructions: null,
    failure_error: null,
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    'INSERT INTO issues (id, team_id, issue_number, title, description, status, creator_member_id, assignee_type, assignee_member_id, assignee_agent_id, reviewer_member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      row.id,
      row.team_id,
      row.issue_number,
      row.title,
      row.description,
      row.status,
      row.creator_member_id,
      row.assignee_type,
      row.assignee_member_id,
      row.assignee_agent_id,
      row.reviewer_member_id,
      row.created_at,
      row.updated_at,
    )
    .run()

  await recordActivity(env, {
    teamId,
    issueId: row.id,
    type: 'issue.created',
    actor: { kind: 'member', memberId: actor.member.id },
    payload: { status: row.status, assignee_type: row.assignee_type },
    now,
  })
  if (assigneeType !== null) {
    await recordActivity(env, {
      teamId,
      issueId: row.id,
      type: 'issue.assigned',
      actor: { kind: 'member', memberId: actor.member.id },
      payload: { assignee_type: assigneeType, assignee_id: assigneeMemberId ?? assigneeAgentId },
      now,
    })
  }
  if (status === 'waiting_host') {
    await recordActivity(env, {
      teamId,
      issueId: row.id,
      type: 'issue.waiting_host',
      actor: { kind: 'system' },
      payload: { assignee_agent_id: assigneeAgentId },
      now,
    })
  }
  await publishEvents(env, teamId, [{ event: 'issue.created', payload: { issue: toIssueView(row) } }])
  if (assigneeMemberId !== null) await pushAssigned(env, row, assigneeMemberId, now)
  return row
}

export async function listIssues(
  env: Env,
  teamId: string,
  options: { statuses?: string[]; assignee?: string; assigneeHostId?: string; restrictToHostId?: string },
): Promise<IssueRow[]> {
  const clauses: string[] = ['team_id = ?']
  const values: (string | number)[] = [teamId]
  if (options.statuses && options.statuses.length > 0) {
    for (const status of options.statuses) {
      if (!isIssueStatus(status)) {
        fail('VALIDATION_FAILED', 'Unknown status value ' + status + '.', { field: 'status' })
      }
    }
    clauses.push('status IN (' + options.statuses.map(() => '?').join(', ') + ')')
    values.push(...options.statuses)
  }
  if (options.assignee !== undefined) {
    clauses.push('(assignee_member_id = ? OR assignee_agent_id = ?)')
    values.push(options.assignee, options.assignee)
  }
  const hostFilter = options.restrictToHostId ?? options.assigneeHostId
  if (hostFilter !== undefined) {
    clauses.push('assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)')
    values.push(hostFilter)
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM issues WHERE ' + clauses.join(' AND ') + ' ORDER BY issue_number',
  )
    .bind(...values)
    .all<IssueRow>()
  return results
}

async function publishIssueUpdate(
  env: Env,
  teamId: string,
  issue: IssueRow,
  changedFields: string[],
  oldStatus: IssueStatus | null,
): Promise<void> {
  const events: ChannelEvent[] = [
    { event: 'issue.updated', payload: { issue: toIssueView(issue), changed_fields: changedFields } },
  ]
  if (oldStatus !== null && oldStatus !== issue.status) {
    events.push({
      event: 'issue.status_changed',
      payload: { issue_id: issue.id, old_status: oldStatus, new_status: issue.status },
    })
  }
  await publishEvents(env, teamId, events)
}

export async function pushAssigned(env: Env, issue: IssueRow, memberId: string, now: number): Promise<void> {
  await sendPush(
    env,
    [memberId],
    {
      teamId: issue.team_id,
      issueId: issue.id,
      eventType: 'assigned',
      body: assignedAlert(issue.issue_number, issue.title),
    },
    now,
  )
}

async function pushReviewRequested(env: Env, issue: IssueRow, now: number): Promise<void> {
  if (issue.reviewer_member_id === null) return
  await sendPush(
    env,
    [issue.reviewer_member_id],
    {
      teamId: issue.team_id,
      issueId: issue.id,
      eventType: 'review_requested',
      body: reviewRequestedAlert(issue.issue_number, issue.title),
    },
    now,
  )
}

/**
 * Section 4 state machine for the human-driven transitions, plus assignment
 * changes. Every branch either applies one row of the matrix or rejects with
 * INVALID_STATE_TRANSITION; the matrix is the only source of allowed edges.
 */
export async function patchIssue(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  issueId: string,
  body: PatchIssueBody,
  now: number,
): Promise<IssueRow> {
  const issue = await findIssue(env, teamId, issueId)
  const patch: Record<string, string | number | null> = {}
  const changed: string[] = []
  const activities: { type: string; payload: Record<string, unknown> }[] = []
  let pushToMember: string | null = null
  let requestReview = false

  if (body.title !== undefined) {
    if ([...body.title].length > ISSUE_TITLE_LIMIT) {
      fail('VALIDATION_FAILED', 'title exceeds ' + ISSUE_TITLE_LIMIT + ' characters.', { limit_chars: ISSUE_TITLE_LIMIT })
    }
    patch.title = body.title
    changed.push('title')
  }
  if (body.description !== undefined) {
    if (new TextEncoder().encode(body.description).length > ISSUE_DESCRIPTION_LIMIT_BYTES) {
      fail('VALIDATION_FAILED', 'description exceeds ' + ISSUE_DESCRIPTION_LIMIT_BYTES + ' bytes.', {
        limit_bytes: ISSUE_DESCRIPTION_LIMIT_BYTES,
      })
    }
    patch.description = body.description
    changed.push('description')
  }
  if (body.reviewer_member_id !== undefined) {
    if (body.reviewer_member_id === '') {
      patch.reviewer_member_id = null
    } else {
      const reviewer = await findMember(env, teamId, body.reviewer_member_id)
      if (!reviewer) {
        fail('VALIDATION_FAILED', 'reviewer_member_id is not a member of this team.', { field: 'reviewer_member_id' })
      }
      patch.reviewer_member_id = reviewer.id
    }
    changed.push('reviewer_member_id')
  }

  if (body.assignee_type !== undefined) {
    if (issue.status === 'running' || issue.status === 'in_review' || issue.status === 'done' || issue.status === 'canceled') {
      fail('INVALID_STATE_TRANSITION', 'The assignee cannot change while the issue is ' + issue.status + '.', {
        status: issue.status,
      })
    }
    if (body.assignee_type !== 'member' && body.assignee_type !== 'agent') {
      fail('VALIDATION_FAILED', "assignee_type must be 'member' or 'agent'.", { field: 'assignee_type' })
    }
    if (body.assignee_id === undefined || body.assignee_id === '') {
      fail('VALIDATION_FAILED', 'assignee_id is required when assignee_type is set.', { field: 'assignee_id' })
    }
    const resolved = await validateAssignee(env, teamId, body.assignee_type, body.assignee_id)
    patch.assignee_type = body.assignee_type
    patch.assignee_member_id = resolved.memberId
    patch.assignee_agent_id = resolved.agentId
    changed.push('assignee_type', 'assignee_member_id', 'assignee_agent_id')
    if (body.assignee_type === 'member') {
      patch.status = 'assigned'
      changed.push('status')
      pushToMember = resolved.memberId
    } else {
      const online = resolved.agentId !== null && (await agentHostOnline(env, resolved.agentId))
      patch.status = online ? 'assigned' : 'waiting_host'
      changed.push('status')
      const effectiveReviewer = patch.reviewer_member_id ?? issue.reviewer_member_id
      if (effectiveReviewer === null) {
        patch.reviewer_member_id = actor.member.id
        changed.push('reviewer_member_id')
      }
    }
    activities.push({ type: 'issue.assigned', payload: { assignee_type: body.assignee_type, assignee_id: body.assignee_id } })
  }

  const requestedStatus = body.status
  if (requestedStatus !== undefined) {
    if (!isIssueStatus(requestedStatus)) {
      fail('VALIDATION_FAILED', 'Unknown status value ' + requestedStatus + '.', { field: 'status' })
    }
    if (requestedStatus === 'canceled') {
      if (issue.status === 'done' || issue.status === 'canceled') {
        fail('INVALID_STATE_TRANSITION', 'The issue is already ' + issue.status + '.', { status: issue.status })
      }
      patch.status = 'canceled'
      patch.lease_token = null
      patch.lease_expires_at = null
      activities.push({ type: 'issue.canceled', payload: { previous_status: issue.status } })
    } else if (requestedStatus === 'in_review') {
      const reviewer = patch.reviewer_member_id ?? issue.reviewer_member_id
      if (issue.status !== 'assigned' || issue.assignee_type !== 'member' || reviewer === null) {
        fail(
          'INVALID_STATE_TRANSITION',
          'Submitting for review requires an assigned member issue with a reviewer.',
          { status: issue.status },
        )
      }
      assertAssigneeOrAdmin(issue, actor)
      patch.status = 'in_review'
      activities.push({ type: 'issue.submitted_for_review', payload: {} })
      requestReview = true
    } else if (requestedStatus === 'done') {
      const reviewer = patch.reviewer_member_id ?? issue.reviewer_member_id
      if (issue.status !== 'assigned' || issue.assignee_type !== 'member' || reviewer !== null) {
        fail(
          'INVALID_STATE_TRANSITION',
          'Completing directly requires an assigned member issue with no reviewer.',
          { status: issue.status },
        )
      }
      assertAssigneeOrAdmin(issue, actor)
      patch.status = 'done'
      activities.push({ type: 'issue.completed', payload: {} })
    } else if (requestedStatus === 'assigned') {
      if (issue.status !== 'failed') {
        fail('INVALID_STATE_TRANSITION', 'Only a failed issue can be retried.', { status: issue.status })
      }
      patch.status = 'assigned'
      patch.failure_error = null
      activities.push({ type: 'issue.retried', payload: {} })
    } else {
      fail('INVALID_STATE_TRANSITION', 'The status ' + requestedStatus + ' is not a human-driven transition.', {
        status: requestedStatus,
      })
    }
    if (!changed.includes('status')) changed.push('status')
  }

  if (changed.length === 0) return issue
  patch.updated_at = now
  await updateIssueRow(env, issueId, patch)
  const updated = await findIssue(env, teamId, issueId)
  for (const activity of activities) {
    await recordActivity(env, {
      teamId,
      issueId,
      type: activity.type,
      actor: { kind: 'member', memberId: actor.member.id },
      payload: activity.payload,
      now,
    })
  }
  await publishIssueUpdate(env, teamId, updated, changed, issue.status)
  if (pushToMember !== null) await pushAssigned(env, updated, pushToMember, now)
  if (requestReview) await pushReviewRequested(env, updated, now)
  return updated
}

async function assertReviewer(env: Env, issue: IssueRow, actor: MemberPrincipal): Promise<void> {
  if (actor.member.role === 'admin') return
  if (issue.reviewer_member_id !== null && issue.reviewer_member_id === actor.member.id) return
  fail('FORBIDDEN', 'Only the reviewer or an admin can decide this review.', { issue_id: issue.id })
}

/** Supplement A4.8: only the assignee or an admin may submit or complete a member card. */
function assertAssigneeOrAdmin(issue: IssueRow, actor: MemberPrincipal): void {
  if (actor.member.role === 'admin') return
  if (issue.assignee_member_id !== null && issue.assignee_member_id === actor.member.id) return
  fail('FORBIDDEN', 'Only the assignee or an admin can move this issue to ' + issue.status + '.', {
    issue_id: issue.id,
    assignee_member_id: issue.assignee_member_id,
  })
}

/** Section 8 approval: in_review to done. */
export async function approveReview(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  issueId: string,
  now: number,
): Promise<IssueRow> {
  const issue = await findIssue(env, teamId, issueId)
  if (issue.status !== 'in_review') {
    fail('INVALID_STATE_TRANSITION', 'Only an issue in review can be approved.', { status: issue.status })
  }
  await assertReviewer(env, issue, actor)
  await updateIssueRow(env, issueId, {
    status: 'done',
    lease_token: null,
    lease_expires_at: null,
    updated_at: now,
  })
  const updated = await findIssue(env, teamId, issueId)
  await recordActivity(env, {
    teamId,
    issueId,
    type: 'issue.approved',
    actor: { kind: 'member', memberId: actor.member.id },
    payload: {},
    now,
  })
  await publishIssueUpdate(env, teamId, updated, ['status'], issue.status)
  return updated
}

/**
 * Section 8 rejection: store the instructions, clear the lease and hand the
 * issue back to the bound Host. The Hub never starts the rework itself; the
 * Host must claim first, which is what keeps a rejected card from running twice.
 */
export async function rejectReview(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  issueId: string,
  instructions: string,
  now: number,
): Promise<IssueRow> {
  const issue = await findIssue(env, teamId, issueId)
  if (issue.status !== 'in_review') {
    fail('INVALID_STATE_TRANSITION', 'Only an issue in review can be rejected.', { status: issue.status })
  }
  await assertReviewer(env, issue, actor)
  if (instructions.trim() === '') fail('VALIDATION_FAILED', 'instructions are required.', { field: 'instructions' })

  const agent = issue.assignee_agent_id === null ? null : await findAgent(env, teamId, issue.assignee_agent_id)
  const hostId = agent?.host_id ?? null
  let nextStatus: IssueStatus = 'assigned'
  if (hostId !== null) {
    const host = await env.DB.prepare('SELECT status FROM hosts WHERE id = ?').bind(hostId).first<{ status: string }>()
    if (host === null || host.status !== 'online') nextStatus = 'waiting_host'
  }
  await updateIssueRow(env, issueId, {
    status: nextStatus,
    rework_instructions: instructions,
    lease_token: null,
    lease_expires_at: null,
    executing_host_id: null,
    execution_attempt_id: null,
    updated_at: now,
  })
  const updated = await findIssue(env, teamId, issueId)
  await recordActivity(env, {
    teamId,
    issueId,
    type: 'issue.rework_requested',
    actor: { kind: 'member', memberId: actor.member.id },
    payload: { instructions, status: nextStatus },
    now,
  })
  const events: ChannelEvent[] = [
    { event: 'issue.updated', payload: { issue: toIssueView(updated), changed_fields: ['status', 'rework_instructions'] } },
    { event: 'issue.status_changed', payload: { issue_id: issueId, old_status: issue.status, new_status: nextStatus } },
  ]
  if (hostId !== null) {
    events.push({
      event: 'issue.rework',
      payload: { issue_id: issueId, instructions, reviewer_member_id: actor.member.id },
      target_host_id: hostId,
    })
  }
  await publishEvents(env, teamId, events)
  return updated
}

export function summaryWithinLimit(summary: string | undefined): string | null {
  if (summary === undefined) return null
  if ([...summary].length > EXECUTION_SUMMARY_LIMIT) {
    fail('VALIDATION_FAILED', 'summary exceeds ' + EXECUTION_SUMMARY_LIMIT + ' characters.', {
      limit_chars: EXECUTION_SUMMARY_LIMIT,
    })
  }
  return summary
}

export { ACTIVE_STATUSES, ALL_STATUSES, publishIssueUpdate }