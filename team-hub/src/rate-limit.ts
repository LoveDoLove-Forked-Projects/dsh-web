import { RATE_LIMIT_WINDOW_MS } from './constants'
import { HubError } from './errors'

export type QuotaScope = 'auth' | 'member' | 'host'

/**
 * Section 11 quotas. A counter is one D1 row per bucket and window, which
 * keeps the window consistent across Worker isolates and Durable Objects.
 * Returns the decision instead of throwing so the caller can attach the retry
 * window.
 */
export async function consumeQuota(
  env: Env,
  scope: QuotaScope,
  identity: string,
  limit: number,
  now: number,
): Promise<void> {
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS
  const bucketKey = `${scope}:${identity}`
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket_key, window_start, request_count) VALUES (?, ?, 1)
     ON CONFLICT(bucket_key, window_start) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  )
    .bind(bucketKey, windowStart)
    .first<{ request_count: number }>()
  const used = row?.request_count ?? 1
  if (used > limit) {
    throw new HubError('RATE_LIMITED', `Rate limit of ${limit} requests per minute exceeded.`, {
      limit,
      window_ms: RATE_LIMIT_WINDOW_MS,
      retry_after_ms: windowStart + RATE_LIMIT_WINDOW_MS - now,
    })
  }
}
