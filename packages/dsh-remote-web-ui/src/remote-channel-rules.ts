/**
 * The remote-channel rewrite contract as pure data (issue #987): both the
 * browser patch (client/remote-channel.ts) and the parse-time boot patch
 * (remote-channel-boot.ts, inlined into index.html by the host) decide from
 * these tables, so the two can never drift apart.
 * @module @linxin666/dsh-remote-web-ui/remote-channel-rules
 */

/** The gated mirror prefix (must match src/remote-methods.ts). */
export const REMOTE_PREFIX = '/remote'

import { REMOTE_DEVICE_HEADER, REMOTE_DEVICE_QUERY } from './remote-methods.ts'

/**
 * Custom schemes that deliver the GUI from the same machine, so their pages
 * are local without a loopback hostname. The official DSH Desktop shell
 * serves its Web GUI from `dsh-app://app/` (`location.hostname === 'app'`,
 * `location.protocol === 'dsh-app:'`), which no hostname predicate can
 * recognise; the plugin's own fences then treated the desktop as a LAN/tunnel
 * origin and asked the user to pair a device the shell can never pair (#1682).
 * Only the page's own delivery scheme is listed here — the entries never
 * influence how a *remote* caller is judged.
 */
export const DESKTOP_PAGE_PROTOCOLS: readonly string[] = ['dsh-app:']

/**
 * Hostname-only loopback classification: localhost, the IPv6 loopback literal
 * (WHATWG keeps its brackets) and any 127/8 IPv4 literal. Kept string-in,
 * boolean-out and dependency-free so the browser half and the inlined boot
 * script can both run it verbatim.
 * @param hostname - a page/cookie hostname, IPv6 literals bracketed.
 * @returns true for a loopback name or literal.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether the current page is served from the machine running the host, so
 * its same-origin traffic must NOT be fenced behind the pairing channel.
 * Three independent facts all describe the page itself and any one is enough:
 *
 * - the page's own hostname is loopback;
 * - the page's protocol is a {@link DESKTOP_PAGE_PROTOCOLS} desktop scheme;
 * - the official connection transport already declared this shell the host
 *   owner (`__DSH_TRANSPORT__.ownsHost === true`) AND the page is not a
 *   network origin. The official client reads the same hook to derive
 *   `connection.isLoopback`, and the desktop shell sets it before any boot
 *   entry — without this term the plugin's predicate contradicts the host's
 *   own conclusion (#1682). The network-origin guard is deliberate: this
 *   plugin's own device-gated landing (a LAN or tunnel page) publishes the
 *   same hook to grant a paired remote the full UI, and that page must keep
 *   riding the gated channel — `ownsHost` buys the presentation, never an
 *   exemption from the pairing fence.
 *
 * @param hostname - `location.hostname` of the page.
 * @param protocol - `location.protocol` of the page (for example `https:`).
 * @param transportOwnsHost - `__DSH_TRANSPORT__?.ownsHost` as read by the caller.
 * @returns true when the page is local and needs no remote channel.
 */
export function isLocalPage(hostname: string, protocol?: string, transportOwnsHost?: boolean): boolean {
  if (protocol !== undefined && DESKTOP_PAGE_PROTOCOLS.includes(protocol)) return true
  if (isLoopbackHostname(hostname)) return true
  // A granted remote also sets ownsHost; only a page whose own origin is
  // otherwise local may treat the hook as proof of a local page.
  return transportOwnsHost === true && !isNetworkOrigin(hostname)
}

/**
 * Whether a hostname can only be reached across a network, so a page on it is
 * remote whatever transport hook it carries: any IPv4/IPv6 literal (a dot or a
 * colon) or any dotted DNS name. A hostname with no dot and no colon is a
 * scheme-local authority (the desktop shell's `app`), which is why this test,
 * not a loopback test, is what the `ownsHost` term is gated on.
 * @param hostname - the page hostname.
 * @returns true when the page cannot be the machine's own local page.
 */
function isNetworkOrigin(hostname: string): boolean {
  return hostname.includes('.') || hostname.includes(':')
}

export { REMOTE_DEVICE_HEADER, REMOTE_DEVICE_QUERY }

/** Connection-plugin method prefix under the gated channel. */
export const REMOTE_API_PREFIX = `${REMOTE_PREFIX}/api`

/**
 * The window global the device-gated app landing publishes to grant host mode.
 * Set by the /pair-app capture script, read by the parse-time boot patch: the
 * transport hook (ownsHost) is server-granted, not asserted from the origin.
 */
export const REMOTE_HOST_GRANT_GLOBAL = '__DSH_REMOTE_HOST_GRANT__'

/** Every decision input of the remote-channel rewrite, JSON-serializable. */
export interface RemoteChannelRules {
  readonly remotePrefix: string
  readonly apiPrefix: string
  readonly pairPrefix: string
  readonly updatePrefix: string
  readonly settingsBridgePrefix: string
  readonly sidebarPrefix: string
  readonly gitPrefix: string
  readonly petPrefix: string
  readonly wsPaths: readonly string[]
  /** Header carrying the cookieless device credential on gated fetches. */
  readonly deviceHeader: string
  /** sessionStorage key holding the device credential (set by /pair-app). */
  readonly deviceKey: string
  /** Query parameter carrying it on WebSocket upgrades. */
  readonly deviceQuery: string
  /** Raw upload route the boot hook keeps on the gated channel. */
  readonly uploadPath: string
  /** Page global the pre-Cordis upload hook is published under. */
  readonly uploadHookGlobal: string
  /**
   * Delivery schemes whose pages are local (see DESKTOP_PAGE_PROTOCOLS).
   * Carried in the rules so the inlined boot script applies the same list.
   */
  readonly desktopProtocols: readonly string[]
  /**
   * Page global carrying the server-issued host-mode grant. Only the plugin's
   * own device-gated app landing (/pair-app) publishes it; the boot patch
   * therefore enables the official UI's host mode only for a shell the server
   * actually granted, never for one that merely happens to sit on a
   * non-loopback origin.
   */
  readonly hostGrantGlobal: string
}

/** The live rule set. */
export const REMOTE_CHANNEL_RULES: RemoteChannelRules = {
  remotePrefix: REMOTE_PREFIX,
  apiPrefix: '/api/',
  pairPrefix: '/api/pair/',
  updatePrefix: '/api/update/',
  settingsBridgePrefix: '/api/dsh-web-ui-settings',
  sidebarPrefix: '/sidebar/',
  gitPrefix: '/git/',
  petPrefix: '/pet/',
  // The official 0.1.2-alpha.2 line opens exactly one stream socket (the
  // Typert gateway mux, /api/remote.mux); the legacy /api/events.* paths
  // were removed by the SDK and stay absent here.
  wsPaths: [
    '/api/remote.mux',
    '/sidebar/ws/terminal',
    '/sidebar/ws/agent-terminals',
    '/sidebar/ws/agent-opens',
    '/api/dsh-ssh/terminal',
  ],
  deviceHeader: REMOTE_DEVICE_HEADER,
  deviceKey: 'dsh-remote-device',
  deviceQuery: REMOTE_DEVICE_QUERY,
  uploadPath: '/api/session/uploadFileBinary',
  uploadHookGlobal: '__DSH_FILE_UPLOAD__',
  desktopProtocols: DESKTOP_PAGE_PROTOCOLS,
  hostGrantGlobal: REMOTE_HOST_GRANT_GLOBAL,
}

/** The window global the boot patch publishes its seat under. */
export const REMOTE_CHANNEL_BOOT_GLOBAL = '__DSH_REMOTE_CHANNEL_BOOT__'

/**
 * The seat the parse-time boot patch installs: hook seats the plugin's
 * client apply adopts, a pending-unpaired flag for signals raised before
 * adoption, and restore() retiring the patch (also removes the global).
 */
export interface RemoteChannelBootSeat {
  onUnpaired: (() => void) | null
  onPaired: (() => void) | null
  pendingUnpaired: boolean
  restore(): void
}
