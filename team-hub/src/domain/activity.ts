import { newId } from '../ids'
import type { ActivityRow } from '../types'

export interface ActivityActor {
  kind: 'member' | 'agent' | 'host' | 'system'
  memberId?: string | null
  agentId?: string | null
  hostId?: string | null
}

export interface ActivityInput {
  teamId: string
  issueId: string
  type: string
  actor: ActivityActor
  payload?: Record<string, unknown>
  now: number
}

/**
 * Section 11 audit: every state change appends one immutable activity row.
 * There is deliberately no update or delete path for this table.
 */
export async function recordActivity(env: Env, input: ActivityInput): Promise<ActivityRow> {
  const row: ActivityRow = {
    id: newId('act', input.now),
    team_id: input.teamId,
    issue_id: input.issueId,
    actor_type: input.actor.kind,
    actor_member_id: input.actor.memberId ?? null,
    actor_agent_id: input.actor.agentId ?? null,
    actor_host_id: input.actor.hostId ?? null,
    activity_type: input.type,
    payload_json: JSON.stringify(input.payload ?? {}),
    created_at: input.now,
  }
  await env.DB.prepare(
    'INSERT INTO activity (id, team_id, issue_id, actor_type, actor_member_id, actor_agent_id, actor_host_id, activity_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      row.id,
      row.team_id,
      row.issue_id,
      row.actor_type,
      row.actor_member_id,
      row.actor_agent_id,
      row.actor_host_id,
      row.activity_type,
      row.payload_json,
      row.created_at,
    )
    .run()
  return row
}
