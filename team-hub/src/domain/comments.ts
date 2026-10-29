import { COMMENT_LIMIT_BYTES, MENTION_PATTERN } from '../constants'
import { fail } from '../errors'
import { newId } from '../ids'
import { publishEvents } from '../channel'
import type { Principal } from '../auth/session'
import type { AgentRow, CommentRow, MemberRow } from '../types'
import { recordActivity } from './activity'
import { findAgent } from './hosts'
import { findIssue } from './issues'
import { mentionedAlert, sendPush } from '../push/apns'

export interface MentionTarget {
  targetType: 'member' | 'agent'
  memberId: string | null
  agentId: string | null
}

export interface CreateCommentBody {
  content: string
  author_type?: string
  author_agent_id?: string
}

/** Section 7 mention syntax: an at-sign followed by a username or agent name. */
export function extractMentionHandles(content: string): string[] {
  const handles: string[] = []
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const handle = match[1]
    if (handle !== undefined) handles.push(handle)
  }
  return [...new Set(handles)]
}

/** Resolve each handle against team members first, then team agents. */
async function resolveMentionTargets(env: Env, teamId: string, content: string): Promise<MentionTarget[]> {
  const targets: MentionTarget[] = []
  for (const handle of extractMentionHandles(content)) {
    const member = await env.DB.prepare(
      'SELECT * FROM members WHERE team_id = ? AND github_username = ? COLLATE NOCASE LIMIT 1',
    )
      .bind(teamId, handle)
      .first<MemberRow>()
    if (member) {
      targets.push({ targetType: 'member', memberId: member.id, agentId: null })
      continue
    }
    const agent = await env.DB.prepare('SELECT * FROM agents WHERE team_id = ? AND name = ? LIMIT 1')
      .bind(teamId, handle)
      .first<AgentRow>()
    if (agent) targets.push({ targetType: 'agent', memberId: null, agentId: agent.id })
  }
  return targets
}

export async function listComments(env: Env, teamId: string, issueId: string): Promise<CommentRow[]> {
  await findIssue(env, teamId, issueId)
  const { results } = await env.DB.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, id')
    .bind(issueId)
    .all<CommentRow>()
  return results
}

/**
 * Section 7 comment submission. The comment row and its mention rows are
 * written in one D1 batch, so a reader never sees a mention that belongs to a
 * comment that failed to land.
 */
export async function createComment(
  env: Env,
  teamId: string,
  principal: Principal,
  issueId: string,
  body: CreateCommentBody,
  now: number,
): Promise<CommentRow> {
  const issue = await findIssue(env, teamId, issueId)
  const content = body.content
  if (new TextEncoder().encode(content).length > COMMENT_LIMIT_BYTES) {
    fail('VALIDATION_FAILED', 'content exceeds ' + COMMENT_LIMIT_BYTES + ' bytes.', { limit_bytes: COMMENT_LIMIT_BYTES })
  }

  let authorType: 'human' | 'agent'
  let authorMemberId: string | null = null
  let authorAgentId: string | null = null
  let authorName: string
  if (principal.kind === 'host') {
    if (body.author_type !== 'agent') {
      fail('FORBIDDEN', 'Host tokens may only post agent comments.', { field: 'author_type' })
    }
    if (body.author_agent_id === undefined || body.author_agent_id === '') {
      fail('VALIDATION_FAILED', 'author_agent_id is required for an agent comment.', { field: 'author_agent_id' })
    }
    const agent = await findAgent(env, teamId, body.author_agent_id)
    if (agent === null || agent.host_id !== principal.host.id) {
      fail('HOST_MISMATCH', 'The author agent belongs to another host.', { field: 'author_agent_id' })
    }
    authorType = 'agent'
    authorAgentId = agent.id
    authorName = agent.name
  } else {
    if (body.author_type !== undefined && body.author_type !== 'human') {
      fail('FORBIDDEN', 'A member session may only post human comments.', { field: 'author_type' })
    }
    authorType = 'human'
    authorMemberId = principal.member.id
    authorName = principal.member.display_name
  }

  const row: CommentRow = {
    id: newId('comm', now),
    team_id: teamId,
    issue_id: issueId,
    author_type: authorType,
    author_member_id: authorMemberId,
    author_agent_id: authorAgentId,
    content,
    created_at: now,
    updated_at: now,
  }
  const targets = await resolveMentionTargets(env, teamId, content)
  const statements = [
    env.DB.prepare(
      'INSERT INTO comments (id, team_id, issue_id, author_type, author_member_id, author_agent_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      row.id,
      row.team_id,
      row.issue_id,
      row.author_type,
      row.author_member_id,
      row.author_agent_id,
      row.content,
      row.created_at,
      row.updated_at,
    ),
    ...targets.map((target) =>
      env.DB.prepare(
        'INSERT INTO comment_mentions (comment_id, target_type, target_member_id, target_agent_id, read_at) VALUES (?, ?, ?, ?, NULL)',
      ).bind(row.id, target.targetType, target.memberId, target.agentId),
    ),
  ]
  await env.DB.batch(statements)

  await recordActivity(env, {
    teamId,
    issueId,
    type: 'comment.created',
    actor:
      authorAgentId !== null
        ? { kind: 'agent', agentId: authorAgentId, hostId: principal.kind === 'host' ? principal.host.id : null }
        : { kind: 'member', memberId: authorMemberId },
    payload: { comment_id: row.id },
    now,
  })
  await publishEvents(env, teamId, [{ event: 'comment.created', payload: { comment: row } }])

  const memberMentions = targets.filter((target) => target.memberId !== null).map((target) => target.memberId as string)
  if (memberMentions.length > 0) {
    await sendPush(
      env,
      memberMentions,
      {
        teamId,
        issueId,
        eventType: 'mentioned',
        body: mentionedAlert(authorName, issue.issue_number),
      },
      now,
    )
  }
  for (const target of targets) {
    if (target.agentId === null) continue
    const agent = await findAgent(env, teamId, target.agentId)
    if (agent === null) continue
    await publishEvents(env, teamId, [
      {
        event: 'comment.mentioned',
        payload: { issue_id: issueId, comment_id: row.id, author: authorName, content },
        target_host_id: agent.host_id,
      },
    ])
  }
  return row
}
