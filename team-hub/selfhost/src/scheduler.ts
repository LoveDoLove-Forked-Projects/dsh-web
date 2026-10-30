import { sweepAllTeams, type SweepResult } from '../../src/domain/sweep'

/**
 * Section 5 step 5, section 6 and the lease sweep, driven by a process timer
 * instead of the Worker's one-minute cron trigger. It runs once at startup and
 * then on the same cadence; a sweep already in flight is never overlapped, so
 * a slow database cannot pile sweeps up.
 */
export interface SweeperOptions {
  /** Milliseconds between sweeps; 0 keeps the startup sweep and stops the timer. */
  intervalMs?: number
  now?: () => number
  log?: (message: string) => void
}

export interface Sweeper {
  /** One sweep now; a run already in flight reports no change. */
  runOnce(): Promise<SweepResult>
  /** Begin the timer; the startup sweep is the caller's first runOnce(). */
  start(): void
  stop(): void
}

const NOTHING_SWEPT: SweepResult = { hosts_offline: 0, leases_expired: 0, questions_expired: 0 }

export function createSweeper(env: Env, options: SweeperOptions = {}): Sweeper {
  const intervalMs = options.intervalMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? ((message: string) => console.log(message))
  let timer: NodeJS.Timeout | null = null
  let running = false

  const runOnce = async (): Promise<SweepResult> => {
    if (running) return NOTHING_SWEPT
    running = true
    try {
      const result = await sweepAllTeams(env, now())
      if (!options.log && result.hosts_offline + result.leases_expired + result.questions_expired > 0) {
        log(
          '[sweep] hosts_offline=' +
            result.hosts_offline +
            ' leases_expired=' +
            result.leases_expired +
            ' questions_expired=' +
            result.questions_expired,
        )
      }
      return result
    } finally {
      running = false
    }
  }

  return {
    runOnce,
    start() {
      if (intervalMs <= 0 || timer !== null) return
      timer = setInterval(() => {
        void runOnce().catch((error: unknown) => {
          log('[sweep] sweep failed: ' + (error instanceof Error ? error.message : String(error)))
        })
      }, intervalMs)
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
  }
}
