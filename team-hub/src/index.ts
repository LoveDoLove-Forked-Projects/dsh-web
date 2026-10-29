import { TeamChannelDO } from './durable/team-channel'
import { handleRequest } from './router'
import { sweepAllTeams } from './domain/sweep'

export { TeamChannelDO }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
  /**
   * Section 5 step 5 and section 6 expiry: the cron trigger is what marks Hosts
   * offline, lapsed leases back to waiting_host and stale questions expired
   * when no client is polling the team.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now()
    ctx.waitUntil(sweepAllTeams(env, now).then(() => undefined))
  },
} satisfies ExportedHandler<Env>
