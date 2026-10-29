import type { MemberPrincipal } from '../auth/session'
import type { ActivityRow, CommentRow, IssueRow, QuestionRow } from '../types'
import { toActivityView, toIssueView, toQuestionView, type ActivityView, type IssueView, type QuestionView } from '../types'
import { fail } from '../errors'
import { findIssue } from './issues'

export interface InboxMention {
  comment: CommentRow
  issue_id: string
}

export interface InboxResult {
  assigned: IssueView[]
  review: IssueView[]
  questions: QuestionView[]
  mentions: InboxMention[]
}

/**
 * Supplement A1.2: everything a member has to act on, in one round trip -
 * issues assigned to them, reviews waiting on them, pending questions they
 * receive, and comments that mention them and are still unread.
 */
export async function getInbox(env: Env, teamId: string, member: MemberPrincipal): Promise<InboxResult> {
  const id = member.member.id
  const assigned = await env.DB.prepare(
    "SELECT * FROM issues WHERE team_id = ? AND status NOT IN ('done', 'canceled') AND assignee_type = 'member' AND assignee_member_id = ? ORDER BY updated_at DESC",
  )
    .bind(teamId, id)
    .all<IssueRow>()
  const reviews = await env.DB.prepare(
    "SELECT * FROM issues WHERE team_id = ? AND status = 'in_review' AND reviewer_member_id = ? ORDER BY updated_at DESC",
  )
    .bind(teamId, id)
    .all<IssueRow>()
  const questions = await env.DB.prepare(
    "SELECT q.* FROM questions q JOIN issues i ON i.id = q.issue_id WHERE q.team_id = ? AND q.status = 'pending' AND (i.reviewer_member_id = ? OR (i.assignee_type = 'member' AND i.assignee_member_id = ?)) ORDER BY q.created_at DESC",
  )
    .bind(teamId, id, id)
    .all<QuestionRow>()
  const mentions = await env.DB.prepare(
    'SELECT c.* FROM comment_mentions m JOIN comments c ON c.id = m.comment_id WHERE m.target_member_id = ? AND m.read_at IS NULL ORDER BY c.created_at DESC',
  )
    .bind(id)
    .all<CommentRow>()
  return {
    assigned: assigned.results.map(toIssueView),
    review: reviews.results.map(toIssueView),
    questions: questions.results.map(toQuestionView),
    mentions: mentions.results.map((comment) => ({ comment, issue_id: comment.issue_id })),
  }
}

/** Supplement A1.2: mark one mention of this member as read. */
export async function markMentionRead(
  env: Env,
  teamId: string,
  member: MemberPrincipal,
  commentId: string,
  now: number,
): Promise<void> {
  const comment = await env.DB.prepare('SELECT * FROM comments WHERE id = ? AND team_id = ?')
    .bind(commentId, teamId)
    .first<CommentRow>()
  if (!comment) fail('NOT_FOUND', 'Comment not found on this team.', { comment_id: commentId })
  await env.DB.prepare(
    'UPDATE comment_mentions SET read_at = ? WHERE comment_id = ? AND target_member_id = ? AND read_at IS NULL',
  )
    .bind(now, commentId, member.member.id)
    .run()
}

export interface ActivityPage {
  activity: ActivityView[]
  next_cursor: string | null
}

/**
 * Supplement A1.4: newest-first activity with a keyset cursor. The cursor is
 * an activity id, so paging stays stable while new activity arrives.
 */
export async function listActivityFeed(
  env: Env,
  teamId: string,
  issueId: string,
  options: { before?: string; limit: number },
): Promise<ActivityPage> {
  await findIssue(env, teamId, issueId)
  const clauses = ['team_id = ?', 'issue_id = ?']
  const values: (string | number)[] = [teamId, issueId]
  if (options.before !== undefined && options.before !== '') {
    const cursor = await env.DB.prepare('SELECT * FROM activity WHERE id = ? AND team_id = ?')
      .bind(options.before, teamId)
      .first<ActivityRow>()
    if (!cursor) fail('VALIDATION_FAILED', 'before does not name an activity of this team.', { field: 'before' })
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
    values.push(cursor.created_at, cursor.created_at, cursor.id)
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM activity WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ?',
  )
    .bind(...values, options.limit + 1)
    .all<ActivityRow>()
  const page = results.slice(0, options.limit)
  return {
    activity: page.map(toActivityView),
    next_cursor: results.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}