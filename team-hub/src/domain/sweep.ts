import { sweepOfflineHosts } from './hosts'
import { sweepAssignedAwaitingHost, sweepExpiredLeases, sweepHostRunningIssues } from './leases'
import { sweepExpiredQuestions } from './questions'

export interface SweepResult {
  hosts_offline: number
  leases_expired: number
  questions_expired: number
}

/**
 * The Hub-system half of the state machine: offline Hosts, lapsed leases and
 * expired questions. Cron drives it in production; tests drive it directly so
 * no behaviour depends on wall-clock timing.
 */
export async function sweepTeam(env: Env, teamId: string, now: number): Promise<SweepResult> {
  const offlineHosts = await sweepOfflineHosts(env, teamId, now)
  let leasesExpired = 0
  for (const host of offlineHosts) {
    leasesExpired += await sweepHostRunningIssues(env, teamId, host.id, now)
  }
  leasesExpired += await sweepExpiredLeases(env, teamId, now)
  await sweepAssignedAwaitingHost(env, teamId, now)
  const questionsExpired = await sweepExpiredQuestions(env, teamId, now)
  return { hosts_offline: offlineHosts.length, leases_expired: leasesExpired, questions_expired: questionsExpired }
}

/** Sweep every team; used by the cron trigger. */
export async function sweepAllTeams(env: Env, now: number): Promise<SweepResult> {
  const { results } = await env.DB.prepare('SELECT id FROM teams').all<{ id: string }>()
  const total: SweepResult = { hosts_offline: 0, leases_expired: 0, questions_expired: 0 }
  for (const team of results) {
    const result = await sweepTeam(env, team.id, now)
    total.hosts_offline += result.hosts_offline
    total.leases_expired += result.leases_expired
    total.questions_expired += result.questions_expired
  }
  return total
}