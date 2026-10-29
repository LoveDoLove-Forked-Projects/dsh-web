/**
 * Loopback-only discovery of an external Chrome DevTools endpoint.
 * @module @linxin666/dsh-client-ui-browser-view/host/cdp-endpoint
 */

import { isLoopbackHostname } from './loopback.ts'

/** Normalized external CDP HTTP endpoint. */
export interface CdpEndpoint {
  /** Origin with no path, credentials, query, or fragment. */
  baseUrl: string
  /** The discovery document that publishes the browser WebSocket. */
  versionUrl: string
}

/** Browser discovery facts needed to open a CDP connection. */
export interface CdpVersion {
  webSocketDebuggerUrl: string
  browser?: string
}

function assertLoopbackUrl(url: URL, protocols: readonly string[], label: string): void {
  if (!protocols.includes(url.protocol)) throw new Error(`${label} must use ${protocols.join(' or ')}`)
  if (!isLoopbackHostname(url.hostname)) throw new Error(`${label} must name a loopback host (localhost, 127/8, or [::1])`)
  if (url.username !== '' || url.password !== '') throw new Error(`${label} must not contain credentials`)
}

/** Parse and normalize the configured HTTP endpoint, failing closed. */
export function parseCdpEndpoint(raw: string): CdpEndpoint {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('cdpEndpoint must be an absolute HTTP URL such as http://127.0.0.1:9222')
  }
  assertLoopbackUrl(url, ['http:'], 'cdpEndpoint')
  if (url.port === '') throw new Error('cdpEndpoint must include an explicit port')
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    throw new Error('cdpEndpoint must be an origin without a path, query, or fragment')
  }
  return { baseUrl: url.origin, versionUrl: new URL('/json/version', url.origin).toString() }
}

/** Validate the WebSocket published by the local discovery document. */
export function parseCdpWebSocketUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('the CDP discovery document returned an invalid webSocketDebuggerUrl')
  }
  assertLoopbackUrl(url, ['ws:', 'wss:'], 'webSocketDebuggerUrl')
  if (url.port === '') throw new Error('webSocketDebuggerUrl must include an explicit port')
  return url.toString()
}

/** Fetch and validate the external browser's discovery document. */
export async function fetchCdpVersion(
  endpoint: CdpEndpoint,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CdpVersion> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? 5_000)
  try {
    const response = await fetchImpl(endpoint.versionUrl, { signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new Error(`discovery returned HTTP ${response.status}`)
    const value = await response.json() as { webSocketDebuggerUrl?: unknown; Browser?: unknown; browser?: unknown }
    if (typeof value.webSocketDebuggerUrl !== 'string' || value.webSocketDebuggerUrl === '') {
      throw new Error('discovery did not return webSocketDebuggerUrl')
    }
    const browser = value.Browser ?? value.browser
    return {
      webSocketDebuggerUrl: parseCdpWebSocketUrl(value.webSocketDebuggerUrl),
      ...(typeof browser === 'string' && browser !== '' ? { browser } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Add the real-browser startup constraints to any external connection error. */
export function realBrowserConnectionError(endpoint: CdpEndpoint, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `Could not connect to the real browser at ${endpoint.baseUrl}: ${reason}. `
      + 'Start Chrome/Edge with --remote-debugging-port and a non-default --user-data-dir. '
      + 'Chrome 136+ ignores remote debugging switches on its default data directory. No isolated-browser fallback was attempted.',
  )
}
