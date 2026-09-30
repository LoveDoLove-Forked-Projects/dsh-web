/**
 * Browser half of the setup API: the same-origin routes the Host serves for
 * configuration reads and writes.
 *
 * The settings card talks to the Host through this module instead of writing
 * the settings namespace itself, which is what keeps one write path: the card,
 * the host routes and the agent tools all reach ./host/setup.ts, so a value
 * typed in the card and a value written by a model produce the same stored
 * configuration. No response here carries a credential value — only whether
 * one is configured, where it came from and whether it is writable.
 *
 * @module dsh-task-board-github/client/setup-api
 */
import { GITHUB_SETUP_API_PREFIX, type GitHubConnectionReport, type GitHubSetupSummary } from '../core/setup.ts'
import type { GitHubRepoConfig } from '../core/types.ts'

/** Hard ceiling for one setup call; a stalled host must not pile up requests. */
const SETUP_FETCH_TIMEOUT_MS = 15_000

/** The setup API as the card uses it. */
export interface GitHubSetupApi {
  /** Credential facts, configured repositories and mount state. */
  status(): Promise<GitHubSetupSummary>
  /** Live connection test against GitHub. */
  test(target?: { owner?: string; repository?: string }): Promise<GitHubConnectionReport>
  /** Store one token in the harness credential store. */
  setCredential(token: string): Promise<GitHubSetupSummary>
  /** Remove the stored token. */
  clearCredential(): Promise<GitHubSetupSummary>
  /** Read the configured repository list. */
  listRepositories(): Promise<GitHubRepoConfig[]>
  /** Replace the configured repository list. */
  writeRepositories(repositories: readonly GitHubRepoConfig[]): Promise<GitHubRepoConfig[]>
}

/**
 * Build the setup API client.
 * @param fetchImpl - fetch implementation (a test seam).
 * @returns the client.
 */
export function createGitHubSetupApi(fetchImpl: typeof fetch = fetch): GitHubSetupApi {
  const call = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(GITHUB_SETUP_API_PREFIX + path, {
      ...init,
      ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      signal: AbortSignal.timeout(SETUP_FETCH_TIMEOUT_MS),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
    if (!response.ok || body.ok === false) {
      throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'the Host refused the request (' + String(response.status) + ')')
    }
    return body
  }

  const asSummary = (body: Record<string, unknown>): GitHubSetupSummary => {
    const credential = typeof body.credential === 'object' && body.credential !== null ? body.credential as GitHubSetupSummary['credential'] : undefined
    return {
      credential: credential ?? { configured: false, writable: false, envName: 'GITHUB_TOKEN' },
      repositories: Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : [],
      running: body.running === true,
      settingsWritable: body.settingsWritable === true,
    }
  }

  return {
    async status() {
      return asSummary(await call('/status'))
    },
    async test(target = {}) {
      const body = await call('/test', { method: 'POST', body: JSON.stringify(target) })
      const report = body.report
      if (typeof report !== 'object' || report === null) throw new Error('the Host returned no test report')
      return report as GitHubConnectionReport
    },
    async setCredential(token) {
      return asSummary(await call('/credential', { method: 'POST', body: JSON.stringify({ token }) }))
    },
    async clearCredential() {
      return asSummary(await call('/credential', { method: 'DELETE' }))
    },
    async listRepositories() {
      const body = await call('/repositories')
      return Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : []
    },
    async writeRepositories(repositories) {
      const body = await call('/repositories', { method: 'PUT', body: JSON.stringify({ repositories }) })
      return Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : []
    },
  }
}
