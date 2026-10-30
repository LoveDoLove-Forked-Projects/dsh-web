import { fail } from '../errors'
import { newId } from '../ids'
import type { MemberRow } from '../types'
import { fetchGithubProfile } from './members'

export interface BootstrapBody {
  team_name: string
  team_slug: string
  github_username: string
}

export interface BootstrapResult {
  team: { id: string; name: string; slug: string }
  member: { id: string; github_username: string; role: 'admin' }
}

/**
 * The first team and its first admin. Login only resolves members that already
 * exist and inviting one needs an admin, so without this step a fresh
 * deployment has no way in at all. The teams table being empty is the whole
 * precondition: the call that fills it is also the last one that succeeds, so
 * the endpoint needs no separate switch to retire.
 */
export async function bootstrapTeam(env: Env, body: BootstrapBody, now: number): Promise<BootstrapResult> {
  const occupied = await env.DB.prepare('SELECT id FROM teams LIMIT 1').first<{ id: string }>()
  if (occupied) {
    fail('CONFLICT', 'This hub already has a team; bootstrap runs once, on the first deployment.', {
      team_id: occupied.id,
    })
  }
  const profile = await fetchGithubProfile(env, body.github_username)
  if (!profile) {
    fail('USER_NOT_FOUND', 'No GitHub user named ' + body.github_username + '.', {
      github_username: body.github_username,
    })
  }
  const team = { id: newId('team', now), name: body.team_name, slug: body.team_slug }
  const member: MemberRow = {
    id: newId('mem', now),
    team_id: team.id,
    github_user_id: profile.id,
    github_username: profile.login,
    display_name: profile.name ?? profile.login,
    avatar_url: profile.avatar_url,
    account_user_id: null,
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  // Both inserts repeat the emptiness test and run as one D1 batch, so two calls
  // that raced past the check above cannot both create a team, and a team never
  // lands without the admin that makes it enterable.
  const results = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO teams (id, name, slug, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM teams)',
    ).bind(team.id, team.name, team.slug, now, now),
    env.DB.prepare(
      'INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, role, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM teams WHERE id = ?)',
    ).bind(
      member.id,
      member.team_id,
      member.github_user_id,
      member.github_username,
      member.display_name,
      member.avatar_url,
      member.role,
      member.status,
      member.created_at,
      member.updated_at,
      team.id,
    ),
  ])
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const winner = await env.DB.prepare('SELECT id FROM teams LIMIT 1').first<{ id: string }>()
    fail('CONFLICT', 'Another bootstrap call created the first team first.', winner ? { team_id: winner.id } : {})
  }
  return {
    team: { id: team.id, name: team.name, slug: team.slug },
    member: { id: member.id, github_username: member.github_username, role: 'admin' },
  }
}
