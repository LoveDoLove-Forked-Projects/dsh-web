import { GITHUB_API_BASE, transportOf } from '../outbound'
import { fail } from '../errors'
import { newId } from '../ids'
import { revokeMemberSessions, type MemberPrincipal } from '../auth/session'
import type { MemberRow } from '../types'
import { toMemberView, type MemberView } from '../types'

export async function getTeam(env: Env, teamId: string): Promise<{ id: string; name: string; slug: string }> {
  const team = await env.DB.prepare('SELECT id, name, slug FROM teams WHERE id = ?')
    .bind(teamId)
    .first<{ id: string; name: string; slug: string }>()
  if (!team) fail('NOT_FOUND', 'Team not found.', { team_id: teamId })
  return team
}

export async function listMembers(env: Env, teamId: string): Promise<MemberView[]> {
  const { results } = await env.DB.prepare('SELECT * FROM members WHERE team_id = ? ORDER BY created_at')
    .bind(teamId)
    .all<MemberRow>()
  return results.map(toMemberView)
}

/** GET /api/v1/me: who the caller is, plus every team they belong to. */
export async function describeMe(
  env: Env,
  principal: MemberPrincipal,
): Promise<{ member: MemberView; teams: { team_id: string; role: 'admin' | 'member' }[] }> {
  const { results } = await env.DB.prepare('SELECT team_id, role FROM members WHERE github_user_id = ? ORDER BY created_at')
    .bind(principal.member.github_user_id)
    .all<{ team_id: string; role: 'admin' | 'member' }>()
  const teams = results.length > 0 ? results : [{ team_id: principal.member.team_id, role: principal.member.role }]
  return { member: toMemberView(principal.member), teams }
}

interface GithubProfile {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

async function fetchGithubProfile(env: Env, username: string): Promise<GithubProfile | null> {
  const response = await transportOf(env)(GITHUB_API_BASE + '/users/' + encodeURIComponent(username), {
    method: 'GET',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-team-hub' },
  })
  if (response.status === 404) return null
  if (response.status !== 200) {
    fail('USER_NOT_FOUND', 'GitHub did not return a profile for ' + username + '.', { github_status: response.status })
  }
  const profile = (await response.json()) as Partial<GithubProfile>
  if (typeof profile.id !== 'number' || typeof profile.login !== 'string') {
    fail('USER_NOT_FOUND', 'GitHub returned an unusable profile for ' + username + '.')
  }
  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === 'string' ? profile.name : null,
    avatar_url: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
  }
}

/**
 * Section 2 member management: an admin invites by GitHub username. The GitHub
 * lookup is what makes USER_NOT_FOUND meaningful and what fills the numeric
 * github_user_id the schema requires before the invitee ever logs in.
 */
export async function inviteMember(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  body: { github_username: string; role: 'admin' | 'member' },
  now: number,
): Promise<MemberView> {
  const profile = await fetchGithubProfile(env, body.github_username)
  if (!profile) fail('USER_NOT_FOUND', 'No GitHub user named ' + body.github_username + '.', {
    github_username: body.github_username,
  })
  const existing = await env.DB.prepare('SELECT * FROM members WHERE team_id = ? AND (github_user_id = ? OR github_username = ? COLLATE NOCASE)')
    .bind(teamId, profile.id, profile.login)
    .first<MemberRow>()
  if (existing) fail('ALREADY_MEMBER', 'This GitHub user is already on the team.', { member_id: existing.id })

  const row: MemberRow = {
    id: newId('mem', now),
    team_id: teamId,
    github_user_id: profile.id,
    github_username: profile.login,
    display_name: profile.name ?? profile.login,
    avatar_url: profile.avatar_url,
    role: body.role,
    status: 'invited',
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    'INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      row.id,
      row.team_id,
      row.github_user_id,
      row.github_username,
      row.display_name,
      row.avatar_url,
      row.role,
      row.status,
      row.created_at,
      row.updated_at,
    )
    .run()
  return toMemberView(row)
}

/**
 * Section 2 step 3: removal suspends the membership and terminates sessions
 * immediately, which the access-token check enforces through the session row.
 */
export async function removeMember(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  memberId: string,
  now: number,
): Promise<void> {
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ? AND team_id = ?')
    .bind(memberId, teamId)
    .first<MemberRow>()
  if (!member) fail('MEMBER_NOT_FOUND', 'Member not found on this team.', { member_id: memberId })
  await env.DB.prepare("UPDATE members SET status = 'suspended', updated_at = ? WHERE id = ?").bind(now, memberId).run()
  await revokeMemberSessions(env, memberId, now)
  await env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL")
    .bind(now, memberId)
    .run()
}