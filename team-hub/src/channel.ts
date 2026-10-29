import type { ChannelEvent } from './durable/team-channel'

/**
 * Publish events to a team's channel. The Durable Object assigns the sequence
 * numbers, appends to the replay buffer and fans out to connected sockets, so
 * the REST handler only states what happened.
 */
export async function publishEvents(env: Env, teamId: string, events: ChannelEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const stub = env.TEAM_CHANNEL.get(env.TEAM_CHANNEL.idFromName(teamId))
  const response = await stub.fetch('https://team-channel.internal/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
  if (!response.ok) {
    throw new Error(`team channel rejected a broadcast with status ${response.status}`)
  }
  const result = (await response.json()) as { seq: number }
  return result.seq
}

/** Latest sequence number held by a team's channel. */
export async function channelState(env: Env, teamId: string): Promise<{ latest_seq: number; oldest_seq: number | null }> {
  const stub = env.TEAM_CHANNEL.get(env.TEAM_CHANNEL.idFromName(teamId))
  const response = await stub.fetch('https://team-channel.internal/state')
  if (!response.ok) throw new Error(`team channel state failed with status ${response.status}`)
  return (await response.json()) as { latest_seq: number; oldest_seq: number | null }
}
