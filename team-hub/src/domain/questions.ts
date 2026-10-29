import { QUESTION_TEXT_LIMIT_BYTES, QUESTION_TTL_MS } from '../constants'
import { fail } from '../errors'
import { newId } from '../ids'
import { publishEvents } from '../channel'
import type { HostPrincipal, MemberPrincipal, Principal } from '../auth/session'
import type { AgentRow, IssueRow, QuestionRow } from '../types'
import { toQuestionView } from '../types'
import { recordActivity } from './activity'
import { findAgent } from './hosts'
import { findIssue } from './issues'
import { questionAskedAlert, sendPush } from '../push/apns'

const QUESTION_STATUSES = new Set(['pending', 'answered', 'dismissed', 'expired'])

export interface QuestionOptionInput {
  label: string
  description?: string
}

export interface CreateQuestionBody {
  question_text: string
  options?: unknown[]
  multi_select?: boolean
}

/** Supplement A2.2: the answer body is one object, never two sibling fields. */
export interface AnswerBody {
  selected?: unknown[]
  custom?: string
}

function validateOptions(raw: unknown[] | undefined): QuestionOptionInput[] | null {
  if (raw === undefined) return null
  const options: QuestionOptionInput[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('VALIDATION_FAILED', 'Every option must be an object with a label.', { field: 'options' })
    }
    const record = entry as Record<string, unknown>
    if (typeof record.label !== 'string' || record.label === '') {
      fail('VALIDATION_FAILED', 'Every option needs a non-empty label.', { field: 'options' })
    }
    if (record.description !== undefined && typeof record.description !== 'string') {
      fail('VALIDATION_FAILED', 'An option description must be a string.', { field: 'options' })
    }
    const option: QuestionOptionInput = { label: record.label }
    if (typeof record.description === 'string') option.description = record.description
    options.push(option)
  }
  return options
}

export async function findQuestion(env: Env, teamId: string, questionId: string): Promise<QuestionRow> {
  const question = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND team_id = ?')
    .bind(questionId, teamId)
    .first<QuestionRow>()
  if (!question) fail('NOT_FOUND', 'Question not found on this team.', { question_id: questionId })
  return question
}

/** Section 6: the issue reviewer, plus the human assignee when there is one. */
export async function questionRecipients(env: Env, issue: IssueRow): Promise<string[]> {
  const recipients: string[] = []
  if (issue.reviewer_member_id !== null) recipients.push(issue.reviewer_member_id)
  if (issue.assignee_type === 'member' && issue.assignee_member_id !== null) {
    recipients.push(issue.assignee_member_id)
  }
  return [...new Set(recipients)]
}

export async function createQuestion(
  env: Env,
  teamId: string,
  host: HostPrincipal,
  issueId: string,
  body: CreateQuestionBody,
  now: number,
): Promise<QuestionRow> {
  const issue = await findIssue(env, teamId, issueId)
  if (issue.assignee_type !== 'agent' || issue.assignee_agent_id === null) {
    fail('HOST_MISMATCH', 'This issue is not assigned to an agent.', { issue_id: issueId })
  }
  const agent = await findAgent(env, teamId, issue.assignee_agent_id)
  if (agent === null || agent.host_id !== host.host.id) {
    fail('HOST_MISMATCH', 'The assigned agent belongs to another host.', { issue_id: issueId })
  }
  if (issue.status !== 'running') {
    fail('INVALID_STATE_TRANSITION', 'A question can only come from a running execution.', { status: issue.status })
  }
  const text = body.question_text
  if (new TextEncoder().encode(text).length > QUESTION_TEXT_LIMIT_BYTES) {
    fail('VALIDATION_FAILED', 'question_text exceeds ' + QUESTION_TEXT_LIMIT_BYTES + ' bytes.', {
      limit_bytes: QUESTION_TEXT_LIMIT_BYTES,
    })
  }
  const options = validateOptions(body.options)
  const row: QuestionRow = {
    id: newId('ques', now),
    team_id: teamId,
    issue_id: issueId,
    host_id: host.host.id,
    agent_id: agent.id,
    question_text: text,
    options_json: options === null ? null : JSON.stringify(options),
    multi_select: body.multi_select === true ? 1 : 0,
    status: 'pending',
    first_responder_member_id: null,
    answer_json: null,
    answered_at: null,
    created_at: now,
    expires_at: now + QUESTION_TTL_MS,
  }
  await env.DB.prepare(
    'INSERT INTO questions (id, team_id, issue_id, host_id, agent_id, question_text, options_json, multi_select, status, first_responder_member_id, answer_json, answered_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)',
  )
    .bind(
      row.id,
      row.team_id,
      row.issue_id,
      row.host_id,
      row.agent_id,
      row.question_text,
      row.options_json,
      row.multi_select,
      row.status,
      row.created_at,
      row.expires_at,
    )
    .run()
  await recordActivity(env, {
    teamId,
    issueId,
    type: 'question.created',
    actor: { kind: 'agent', agentId: agent.id, hostId: host.host.id },
    payload: { question_id: row.id },
    now,
  })
  await publishEvents(env, teamId, [{ event: 'question.created', payload: { question: toQuestionView(row) } }])
  const recipients = await questionRecipients(env, issue)
  if (recipients.length > 0) {
    await sendPush(
      env,
      recipients,
      {
        teamId,
        issueId,
        eventType: 'question_asked',
        body: questionAskedAlert(agent.name, issue.issue_number, text),
        questionId: row.id,
      },
      now,
    )
  }
  return row
}

/**
 * Section 6 resolution: the first response wins. A conditional UPDATE is the
 * arbiter, so two simultaneous answers cannot both be recorded.
 */
export async function answerQuestion(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  questionId: string,
  body: AnswerBody,
  now: number,
): Promise<void> {
  const question = await findQuestion(env, teamId, questionId)
  if (question.status === 'answered') {
    fail('QUESTION_ALREADY_ANSWERED', 'Another member already answered this question.', {
      first_responder_member_id: question.first_responder_member_id,
    })
  }
  if (question.status !== 'pending') {
    fail('QUESTION_NOT_PENDING', 'The question is ' + question.status + '.', { status: question.status })
  }
  const selected: string[] = []
  for (const value of body.selected ?? []) {
    if (typeof value !== 'string') {
      fail('VALIDATION_FAILED', 'selected must be an array of strings.', { field: 'selected' })
    }
    selected.push(value)
  }
  const custom = body.custom
  if (custom !== undefined && typeof custom !== 'string') {
    fail('VALIDATION_FAILED', 'custom must be a string.', { field: 'custom' })
  }
  if (selected.length === 0 && (custom === undefined || custom.trim() === '')) {
    fail('VALIDATION_FAILED', 'An answer needs at least one selected option or a custom text.', {
      fields: ['selected', 'custom'],
    })
  }
  const answer: Record<string, unknown> = { selected }
  if (custom !== undefined && custom.trim() !== '') answer.custom = custom
  const result = await env.DB.prepare(
    "UPDATE questions SET status = 'answered', first_responder_member_id = ?, answer_json = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(actor.member.id, JSON.stringify(answer), now, questionId)
    .run()
  if ((result.meta.changes ?? 0) === 0) {
    fail('QUESTION_ALREADY_ANSWERED', 'Another member answered this question first.', { question_id: questionId })
  }
  await recordActivity(env, {
    teamId,
    issueId: question.issue_id,
    type: 'question.answered',
    actor: { kind: 'member', memberId: actor.member.id },
    payload: { question_id: questionId, answer },
    now,
  })
  await publishEvents(env, teamId, [
    { event: 'question.answered', payload: { question_id: questionId, answer, responder_member_id: actor.member.id } },
  ])
}

/** Section 6 withdrawal: the requesting Host must own the question. */
export async function withdrawQuestion(
  env: Env,
  teamId: string,
  principal: Principal,
  questionId: string,
  now: number,
): Promise<void> {
  const question = await findQuestion(env, teamId, questionId)
  if (principal.kind === 'host') {
    if (question.host_id !== principal.host.id) {
      fail('HOST_MISMATCH', 'This host did not ask this question.', { question_id: questionId })
    }
  } else if (principal.member.role !== 'admin') {
    fail('FORBIDDEN', 'Only the asking Host or an admin can withdraw a question.', { question_id: questionId })
  }
  if (question.status !== 'pending') {
    fail('QUESTION_NOT_PENDING', 'The question is ' + question.status + '.', { status: question.status })
  }
  const result = await env.DB.prepare("UPDATE questions SET status = 'dismissed' WHERE id = ? AND status = 'pending'")
    .bind(questionId)
    .run()
  if ((result.meta.changes ?? 0) === 0) {
    fail('QUESTION_NOT_PENDING', 'The question is no longer pending.', { question_id: questionId })
  }
  await recordActivity(env, {
    teamId,
    issueId: question.issue_id,
    type: 'question.withdrawn',
    actor:
      principal.kind === 'host'
        ? { kind: 'host', hostId: principal.host.id }
        : { kind: 'member', memberId: principal.member.id },
    payload: { question_id: questionId },
    now,
  })
  await publishEvents(env, teamId, [
    { event: 'question.withdrawn', payload: { question_id: questionId, issue_id: question.issue_id } },
  ])
}

export async function listQuestions(
  env: Env,
  teamId: string,
  filter: { status?: string; issueId?: string },
): Promise<QuestionRow[]> {
  if (filter.status !== undefined && !QUESTION_STATUSES.has(filter.status)) {
    fail('VALIDATION_FAILED', 'Unknown question status ' + filter.status + '.', { field: 'status' })
  }
  const clauses = ['team_id = ?']
  const values: string[] = [teamId]
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    values.push(filter.status)
  }
  if (filter.issueId !== undefined) {
    clauses.push('issue_id = ?')
    values.push(filter.issueId)
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM questions WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at DESC',
  )
    .bind(...values)
    .all<QuestionRow>()
  return results
}

/** Section 6 termination: a pending question past its 24 hour TTL expires. */
export async function sweepExpiredQuestions(env: Env, teamId: string, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM questions WHERE team_id = ? AND status = 'pending' AND expires_at <= ?",
  )
    .bind(teamId, now)
    .all<QuestionRow>()
  let expired = 0
  for (const question of results) {
    const result = await env.DB.prepare("UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .bind(question.id)
      .run()
    if ((result.meta.changes ?? 0) === 0) continue
    expired += 1
    await recordActivity(env, {
      teamId,
      issueId: question.issue_id,
      type: 'question.expired',
      actor: { kind: 'system' },
      payload: { question_id: question.id },
      now,
    })
    await publishEvents(env, teamId, [
      { event: 'question.expired', payload: { question_id: question.id, issue_id: question.issue_id } },
    ])
  }
  return expired
}

/** Agent record behind a question, for consumers that need the name. */
export async function questionAgent(env: Env, question: QuestionRow): Promise<AgentRow | null> {
  return findAgent(env, question.team_id, question.agent_id)
}