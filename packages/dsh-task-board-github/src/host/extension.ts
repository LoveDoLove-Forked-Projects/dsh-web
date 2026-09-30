/**
 * The task board's GitHub provider, assembled as one extension.
 *
 * Everything GitHub-specific lives behind this factory: the board admits it
 * through the cordis `taskBoard` service, hands it the capability face, and
 * never learns what the provider does with it. This module imports no board
 * internals — only the same-shape contract in `../core/contract.ts`.
 *
 * @module dsh-task-board-github/host/extension
 */
import {
  TASK_BOARD_API_VERSION,
  type TaskBoardExtension,
  type TaskBoardExtensionActionRequest,
  type TaskBoardExtensionHost,
} from '../core/contract.ts'
import type { HostTimerFace } from '../core/timers.ts'
import { GITHUB_EXTENSION_ID, type GitHubRepoConfig } from '../core/types.ts'
import { GitHubApiClient } from './client.ts'
import { GitHubSyncService } from './service.ts'
import { buildGitHubTools, buildSetupTools } from './tools.ts'
import type { GitHubSetup } from './setup.ts'

export { GITHUB_EXTENSION_ID }

export interface GitHubExtensionOptions {
  repositories?: GitHubRepoConfig[]
  client?: GitHubApiClient
  /**
   * Resolved credential the client authenticates with. The host half resolves
   * it (credential store first, environment second) and remounts the provider
   * when it changes; absent falls back to the client's own environment read.
   */
  token?: string
  /**
   * Credential reference the token is resolved under; a name, never a value.
   */
  tokenEnv?: string
  timers?: HostTimerFace
  now?: () => number
  /**
   * Volatile master switch, read at use time by the board's registry. Absent
   * means enabled, which is the schema default.
   */
  enabled?: () => boolean
  /**
   * The shared setup surface the configuration tools render. Absent (a bare
   * programmatic mount) registers the synchronization tools only.
   */
  setup?: GitHubSetup
}

/** One provider action the GitHub browser half dispatches. */
function requireTaskId(request: TaskBoardExtensionActionRequest): string {
  if (request.taskId === undefined || request.taskId === '') {
    throw new Error(`github action "${request.action}" requires a taskId`)
  }
  return request.taskId
}

function stringField(request: TaskBoardExtensionActionRequest, key: string): string | undefined {
  const value = request.payload?.[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(request: TaskBoardExtensionActionRequest, key: string): number | undefined {
  const value = request.payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Build the GitHub provider extension. The service is created on start(), when
 * the board hands over the capability face, and released on stop().
 * @param options - deployment configuration for the integration.
 * @returns the extension the board registers.
 */
export function createGitHubExtension(options: GitHubExtensionOptions = {}): TaskBoardExtension {
  let service: GitHubSyncService | undefined
  const disposers: Array<() => void> = []

  const settings = (host: TaskBoardExtensionHost): GitHubSyncService => {
    service ??= new GitHubSyncService({
      host,
      client: options.client ?? new GitHubApiClient({ token: options.token, tokenEnv: options.tokenEnv }),
      repositories: options.repositories,
      timers: options.timers,
      now: options.now,
    })
    return service
  }

  return {
    id: GITHUB_EXTENSION_ID,
    apiVersion: TASK_BOARD_API_VERSION,
    enabled: () => options.enabled?.() ?? true,
    start(host) {
      const sync = settings(host)
      disposers.push(host.events.onExecutionSettled(event => {
        const task = host.tasks.get(event.taskId)
        const execution = task?.executions.find(entry => entry.id === event.executionId)
        if (execution === undefined) return
        void sync.handleExecutionSettled(event.taskId, execution).catch(() => {})
      }))
      disposers.push(host.events.onStatusChanged(event => {
        void sync.writeBackTaskStatus(event.taskId, event.status).catch(() => {})
      }))
      // The identity index is the provider's own structure; a deleted card must
      // leave it, or a later sync would address a card that no longer exists.
      disposers.push(host.events.onTaskDeleted(event => {
        try {
          sync.handleTaskDeleted(event.taskId)
        } catch {
          // A provider-side bookkeeping failure must not disturb the board.
        }
      }))
      for (const tool of [...buildGitHubTools(sync), ...buildSetupTools(options.setup)]) {
        try {
          disposers.push(host.registerTool(tool))
        } catch {
          // A missing tool registry costs the tool surface only.
        }
      }
      try {
        host.publish(sync.snapshotSummary())
      } catch {
        // A refused summary only costs the settings card its status line.
      }
      sync.start()
    },
    stop() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* best-effort */ }
      }
      service?.dispose()
      service = undefined
    },
    async handleAction(request: TaskBoardExtensionActionRequest) {
      if (service === undefined) throw new Error('GitHub extension is not running')
      switch (request.action) {
        case 'refresh': {
          const taskId = request.taskId
          if (taskId !== undefined && taskId !== '') {
            const result = await service.syncTask(taskId)
            if (!result.ok) throw new Error(result.error ?? 'sync failed')
            return { ok: true, synced: 1 }
          }
          const owner = stringField(request, 'owner')
          const repository = stringField(request, 'repository')
          const result = owner !== undefined && repository !== undefined
            ? await service.syncRepository(owner, repository)
            : await service.syncAll()
          if (result.errors.length > 0) throw new Error(result.errors.join('; '))
          return { ok: true, synced: result.synced }
        }
        case 'create-pr': {
          const taskId = requireTaskId(request)
          const headBranch = stringField(request, 'headBranch')
          if (headBranch === undefined || headBranch.trim() === '') throw new Error('headBranch is required')
          const baseBranch = stringField(request, 'baseBranch')
          const title = stringField(request, 'title')
          const body = stringField(request, 'body')
          const pullRequest = await service.createPullRequest(taskId, {
            headBranch,
            ...(baseBranch === undefined ? {} : { baseBranch }),
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
            ...(request.payload?.draft === undefined ? {} : { draft: request.payload.draft === true }),
          })
          return { ok: true, pullRequest }
        }
        case 'link-pr': {
          const taskId = requireTaskId(request)
          const pullRequestNumber = numberField(request, 'pullRequestNumber')
          if (pullRequestNumber === undefined || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
            throw new Error('pullRequestNumber must be a positive integer')
          }
          const pullRequest = await service.linkPullRequest(taskId, pullRequestNumber)
          return { ok: true, pullRequest }
        }
        default:
          throw new Error(`unknown GitHub action "${request.action}"`)
      }
    },
  }
}
