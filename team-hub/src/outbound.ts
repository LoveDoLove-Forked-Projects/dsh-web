/**
 * Outbound HTTP for the two external services the Hub calls: GitHub and APNs.
 *
 * The transport is injectable through the environment so the test suite can
 * serve both contracts with fakes that see the exact requests the Hub builds;
 * production leaves it unset and the global fetch is used.
 */

export type OutboundTransport = (url: string, init: RequestInit) => Promise<Response>

/** Test seam: an Environment carrying this field answers with the injected transport. */
export interface InjectableOutbound {
  TEAM_HUB_OUTBOUND?: OutboundTransport
}

export const GITHUB_OAUTH_BASE = 'https://github.com'
export const GITHUB_API_BASE = 'https://api.github.com'
export const APNS_PRODUCTION_BASE = 'https://api.push.apple.com'
export const APNS_SANDBOX_BASE = 'https://api.sandbox.push.apple.com'
/** GitHub OAuth App callback registered by the Hub operator. */
export const GITHUB_CALLBACK_PATH = '/auth/github/callback'
/** Custom URL scheme the iOS app registers (PROTOCOL.md section 2). */
export const IOS_REDIRECT_URI = 'whale://auth/callback'

export function transportOf(env: Env): OutboundTransport {
  const injected = (env as Env & InjectableOutbound).TEAM_HUB_OUTBOUND
  if (injected) return injected
  return (url, init) => fetch(url, init)
}
