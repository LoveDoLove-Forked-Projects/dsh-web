import { HOST_OFFLINE_THRESHOLD_MS } from '../constants'
import { fail } from '../errors'
import { newId, randomHex } from '../ids'
import { mintHostToken as mintToken, type MemberPrincipal } from '../auth/session'
import { publishEvents } from '../channel'
import type { AgentRow, HostRow } from '../types'

export interface AgentDefinition {
  name: string
  preset_id: string
  description?: string | null
}

export interface RegistrationBody {
  hostname: string
  client_version: string
  agents: AgentDefinition[]
}

export async function findHost(env: Env, teamId: string, hostId: string): Promise<HostRow> {
  const host = await env.DB.prepare('SELECT * FROM hosts WHERE id = ? AND team_id = ?').bind(hostId, teamId).first<HostRow>()
  if (!host) fail('HOST_NOT_FOUND', 'Host not found on this team.', { host_id: hostId })
  return host
}

export async function listAgents(env: Env, teamId: string): Promise<AgentRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM agents WHERE team_id = ? ORDER BY name').bind(teamId).all<AgentRow>()
  return results
}

export async function findAgent(env: Env, teamId: string, agentId: string): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agents WHERE id = ? AND team_id = ?').bind(agentId, teamId).first<AgentRow>()
}

/** POST /hosts/tokens: an admin mints the credential a Host registers with. */
export async function issueHostToken(
  env: Env,
  teamId: string,
  actor: MemberPrincipal,
  body: { hostname: string },
  now: number,
): Promise<{ host_id: string; host_token: string }> {
  const minted = mintToken()
  const host: HostRow = {
    id: newId('host', now),
    team_id: teamId,
    owner_member_id: actor.member.id,
    hostname: body.hostname,
    client_version: '',
    token_hash: await minted.tokenHash,
    status: 'offline',
    last_heartbeat_at: 0,
    created_at: now,
    updated_at: now,
  }
  await env.DB.prepare(
    'INSERT INTO hosts (id, team_id, owner_member_id, hostname, client_version, token_hash, status, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      host.id,
      host.team_id,
      host.owner_member_id,
      host.hostname,
      host.client_version,
      host.token_hash,
      host.status,
      host.last_heartbeat_at,
      host.created_at,
      host.updated_at,
    )
    .run()
  return { host_id: host.id, host_token: minted.token }
}

/** POST /hosts/:hostId/revoke-token: overwrite the hash so the token stops resolving. */
export async function revokeHostToken(env: Env, teamId: string, hostId: string, now: number): Promise<void> {
  await findHost(env, teamId, hostId)
  await env.DB.prepare("UPDATE hosts SET status = 'revoked', token_hash = ?, updated_at = ? WHERE id = ?")
    .bind('revoked:' + randomHex(16), now, hostId)
    .run()
}

async function markOnline(env: Env, host: HostRow, now: number): Promise<boolean> {
  const wasOffline = host.status !== 'online'
  await env.DB.prepare("UPDATE hosts SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, host.id)
    .run()
  if (wasOffline) {
    await publishEvents(env, host.team_id, [
      { event: 'host.status_changed', payload: { host_id: host.id, status: 'online' } },
    ])
  }
  return wasOffline
}

/**
 * Section 5 registration: the Host announces itself and its agent definitions.
 * Agent rows are synchronised here; an agent the Host stops advertising is
 * marked offline rather than deleted, because issues still reference it.
 */
export async function registerHost(env: Env, host: HostRow, body: RegistrationBody, now: number): Promise<{ host_id: string; status: string }> {
  await markOnline(env, host, now)
  await env.DB.prepare('UPDATE hosts SET hostname = ?, client_version = ?, updated_at = ? WHERE id = ?')
    .bind(body.hostname, body.client_version, now, host.id)
    .run()

  const names: string[] = []
  for (const definition of body.agents) {
    names.push(definition.name)
    const existing = await env.DB.prepare('SELECT * FROM agents WHERE team_id = ? AND name = ?')
      .bind(host.team_id, definition.name)
      .first<AgentRow>()
    if (existing && existing.host_id !== host.id) {
      fail('VALIDATION_FAILED', 'Agent name ' + definition.name + ' already belongs to another host.', {
        field: 'agents',
        name: definition.name,
      })
    }
    if (existing) {
      await env.DB.prepare(
        "UPDATE agents SET preset_id = ?, description = ?, owner_member_id = ?, status = 'idle', updated_at = ? WHERE id = ?",
      )
        .bind(definition.preset_id, definition.description ?? null, host.owner_member_id, now, existing.id)
        .run()
    } else {
      await env.DB.prepare(
        'INSERT INTO agents (id, team_id, host_id, owner_member_id, name, preset_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          newId('agent', now),
          host.team_id,
          host.id,
          host.owner_member_id,
          definition.name,
          definition.preset_id,
          definition.description ?? null,
          'idle',
          now,
          now,
        )
        .run()
    }
  }
  if (names.length > 0) {
    const marks = names.map(() => '?').join(', ')
    await env.DB.prepare("UPDATE agents SET status = 'offline', updated_at = ? WHERE host_id = ? AND name NOT IN (" + marks + ')')
      .bind(now, host.id, ...names)
      .run()
  } else {
    await env.DB.prepare("UPDATE agents SET status = 'offline', updated_at = ? WHERE host_id = ?").bind(now, host.id).run()
  }
  return { host_id: host.id, status: 'online' }
}

/** Section 5 heartbeat: liveness of one Host, and the anchor of offline detection. */
export async function heartbeat(env: Env, host: HostRow, hostId: string, now: number): Promise<{ ok: true; server_time: number }> {
  if (host.id !== hostId) {
    fail('HOST_MISMATCH', 'This Host token does not belong to the host in the path.', { host_id: hostId })
  }
  await markOnline(env, host, now)
  return { ok: true, server_time: now }
}

/** Section 5 step 5: no heartbeat for the offline threshold marks the Host offline. */
export async function sweepOfflineHosts(env: Env, teamId: string, now: number): Promise<HostRow[]> {
  const cutoff = now - HOST_OFFLINE_THRESHOLD_MS
  const { results } = await env.DB.prepare("SELECT * FROM hosts WHERE team_id = ? AND status = 'online' AND last_heartbeat_at < ?")
    .bind(teamId, cutoff)
    .all<HostRow>()
  for (const host of results) {
    await env.DB.prepare("UPDATE hosts SET status = 'offline', updated_at = ? WHERE id = ?").bind(now, host.id).run()
    await publishEvents(env, teamId, [
      { event: 'host.status_changed', payload: { host_id: host.id, status: 'offline' } },
    ])
  }
  return results
}

export async function hostsOfTeam(env: Env, teamId: string): Promise<HostRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM hosts WHERE team_id = ?').bind(teamId).all<HostRow>()
  return results
}