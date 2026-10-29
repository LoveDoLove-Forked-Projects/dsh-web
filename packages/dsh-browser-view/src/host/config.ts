/**
 * Browser-view plugin configuration. The Host turns this volatile schema into
 * the profile entry's settings form and commits edits into live references.
 * @module @linxin666/dsh-client-ui-browser-view/host/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Runtime configuration: one live reference per settings field. */
export interface Config {
  realBrowserEnabled: Volatile<boolean>
  cdpEndpoint: Volatile<string>
}

/** Profile-patch shape before the schema adds defaults and live references. */
export interface ConfigInput {
  realBrowserEnabled?: boolean
  cdpEndpoint?: string
}

/** Values after defaults and live references have been resolved. */
export interface ResolvedConfig {
  realBrowserEnabled: boolean
  cdpEndpoint: string
}

/** Settings schema exported through the host loader entry. */
export const Config: z<ConfigInput, Config> = z.object({
  realBrowserEnabled: z.boolean().default(false).volatile().description(
    'Connect the browser tools to a real Chrome/Edge over CDP instead of launching an isolated temporary browser. Off by default.',
  ),
  cdpEndpoint: z.string().default('http://127.0.0.1:9222').volatile().description(
    'Loopback CDP endpoint only. Chrome 136+ ignores remote debugging on its default data directory; use a browser profile explicitly started with remote debugging and a non-default --user-data-dir.',
  ),
})

/** Read the current values, including edits committed without a plugin remount. */
export function effectiveConfig(config?: Config): ResolvedConfig {
  return {
    realBrowserEnabled: config?.realBrowserEnabled?.get() ?? false,
    cdpEndpoint: config?.cdpEndpoint?.get() ?? 'http://127.0.0.1:9222',
  }
}
