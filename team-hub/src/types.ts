/**
 * Row shapes as D1 returns them and the JSON shapes the wire format exposes
 * (PROTOCOL.md section 9). Column names stay snake_case on both sides: the
 * specification's payload examples use them directly.
 */

export interface TeamRow {
  id: string
  name: string
  slug: string
  created_at: number
  updated_at: number
}

export interface MemberRow {
  id: string
  team_id: string
  github_user_id: number
  github_username: string
  display_name: string
  avatar_url: string | null
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'suspended'
  created_at: number
  updated_at: number
}

export interface HostRow {
  id: string
  team_id: string
  owner_member_id: string
  hostname: string
  client_version: string
  token_hash: string
  status: 'online' | 'offline' | 'revoked'
  last_heartbeat_at: number
  created_at: number
  updated_at: number
}

export interface AgentRow {
  id: string
  team_id: string
  host_id: string
  owner_member_id: string
  name: string
  preset_id: string
  description: string | null
  status: 'idle' | 'busy' | 'offline'
  created_at: number
  updated_at: number
}

export interface IssueRow {
  id: string
  team_id: string
  issue_number: number
  title: string
  description: string
  status: 'todo' | 'assigned' | 'waiting_host' | 'running' | 'in_review' | 'done' | 'canceled' | 'failed'
  creator_member_id: string
  assignee_type: 'member' | 'agent' | null
  assignee_member_id: string | null
  assignee_agent_id: string | null
  reviewer_member_id: string | null
  executing_host_id: string | null
  lease_token: string | null
  lease_expires_at: number | null
  execution_attempt_id: string | null
  execution_summary: string | null
  rework_instructions: string | null
  failure_error: string | null
  created_at: number
  updated_at: number
}

export interface CommentRow {
  id: string
  team_id: string
  issue_id: string
  author_type: 'human' | 'agent'
  author_member_id: string | null
  author_agent_id: string | null
  content: string
  created_at: number
  updated_at: number
}

export interface ActivityRow {
  id: string
  team_id: string
  issue_id: string
  actor_type: 'member' | 'agent' | 'host' | 'system'
  actor_member_id: string | null
  actor_agent_id: string | null
  actor_host_id: string | null
  activity_type: string
  payload_json: string
  created_at: number
}

export interface QuestionRow {
  id: string
  team_id: string
  issue_id: string
  host_id: string
  agent_id: string
  question_text: string
  options_json: string | null
  multi_select: number
  status: 'pending' | 'answered' | 'dismissed' | 'expired'
  first_responder_member_id: string | null
  answer_json: string | null
  answered_at: number | null
  created_at: number
  expires_at: number
}

export interface PushTokenRow {
  id: string
  member_id: string
  platform: 'ios' | 'macos'
  device_token: string
  bundle_id: string
  environment: 'production' | 'sandbox'
  created_at: number
  updated_at: number
}

/** A member as section 9 responses expose it; no token material. */
export interface MemberView {
  id: string
  team_id: string
  github_user_id: number
  github_username: string
  display_name: string
  avatar_url: string | null
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'suspended'
  created_at: number
  updated_at: number
}

export interface IssueView extends Omit<IssueRow, 'lease_token' | 'lease_expires_at'> {
  lease_expires_at: number | null
  has_lease: boolean
}

export interface QuestionView {
  id: string
  team_id: string
  issue_id: string
  host_id: string
  agent_id: string
  question_text: string
  options: unknown[] | null
  multi_select: boolean
  status: QuestionRow['status']
  first_responder_member_id: string | null
  answer: unknown
  answered_at: number | null
  created_at: number
  expires_at: number
}

export interface ActivityView {
  id: string
  team_id: string
  issue_id: string
  actor_type: ActivityRow['actor_type']
  actor_member_id: string | null
  actor_agent_id: string | null
  actor_host_id: string | null
  activity_type: string
  payload: Record<string, unknown>
  created_at: number
}

function parseJsonColumn(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function toMemberView(row: MemberRow): MemberView {
  return {
    id: row.id,
    team_id: row.team_id,
    github_user_id: row.github_user_id,
    github_username: row.github_username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function toIssueView(row: IssueRow): IssueView {
  return {
    id: row.id,
    team_id: row.team_id,
    issue_number: row.issue_number,
    title: row.title,
    description: row.description,
    status: row.status,
    creator_member_id: row.creator_member_id,
    assignee_type: row.assignee_type,
    assignee_member_id: row.assignee_member_id,
    assignee_agent_id: row.assignee_agent_id,
    reviewer_member_id: row.reviewer_member_id,
    executing_host_id: row.executing_host_id,
    lease_expires_at: row.lease_expires_at,
    has_lease: row.lease_token !== null,
    execution_attempt_id: row.execution_attempt_id,
    execution_summary: row.execution_summary,
    rework_instructions: row.rework_instructions,
    failure_error: row.failure_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function toQuestionView(row: QuestionRow): QuestionView {
  return {
    id: row.id,
    team_id: row.team_id,
    issue_id: row.issue_id,
    host_id: row.host_id,
    agent_id: row.agent_id,
    question_text: row.question_text,
    options: parseJsonColumn(row.options_json) as unknown[] | null,
    multi_select: row.multi_select === 1,
    status: row.status,
    first_responder_member_id: row.first_responder_member_id,
    answer: parseJsonColumn(row.answer_json),
    answered_at: row.answered_at,
    created_at: row.created_at,
    expires_at: row.expires_at,
  }
}

export function toActivityView(row: ActivityRow): ActivityView {
  const parsed = parseJsonColumn(row.payload_json)
  return {
    id: row.id,
    team_id: row.team_id,
    issue_id: row.issue_id,
    actor_type: row.actor_type,
    actor_member_id: row.actor_member_id,
    actor_agent_id: row.actor_agent_id,
    actor_host_id: row.actor_host_id,
    activity_type: row.activity_type,
    payload: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
    created_at: row.created_at,
  }
}
