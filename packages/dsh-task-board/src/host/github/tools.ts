/**
 * Model-visible tools the GitHub extension contributes to the task board.
 *
 * This file lives with the provider: the board's own agent-tools module never
 * learns GitHub vocabulary. The tools register through the extension
 * capability face, so they follow the same board-enabled x extension-enabled
 * gate as every other provider surface.
 *
 * @module dsh-task-board/host/github/tools
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { readTaskGitHubMetadata } from '../../core/github/types.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import type { GitHubSyncService } from './service.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function json(value: unknown): Json {
  return value as Json
}

function refused(code: string, message: string): Json {
  return json({ ok: false, code, message })
}

function githubTaskSummary(task: TaskRecord): Record<string, unknown> {
  const gh = readTaskGitHubMetadata(task)
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    archived: task.archivedAt !== undefined,
    github: gh === undefined ? undefined : {
      owner: gh.owner,
      repository: gh.repository,
      issueNumber: gh.issueNumber,
      issueUrl: gh.issueUrl,
      remoteTitle: gh.remoteTitle,
      remoteState: gh.remoteState,
      remoteLabels: gh.remoteLabels,
      lastSyncedAt: gh.lastSyncedAt,
      lastSyncError: gh.lastSyncError,
      deactivated: gh.deactivated,
      pullRequest: gh.pullRequest,
    },
  }
}

/** Every GitHub tool, bound to the running sync service. */
export function buildGitHubTools(service: GitHubSyncService): ToolDefinition[] {
  return [
    buildListTool(service),
    buildGetTool(service),
    buildRefreshTool(service),
    buildCreatePrTool(service),
    buildLinkPrTool(service),
  ]
}

function buildListTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_list',
    description: 'List task board cards associated with GitHub issues, with their remote issue state, remote labels, and pull request metadata. Triggers: github list, github tasks, 列出github任务, github issue列表.',
    parameters: {
      owner: { type: 'string', description: 'Filter by repository owner.' },
      repository: { type: 'string', description: 'Filter by repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by remote issue state (open, closed, or all; default: all).' },
      hasPr: { type: 'boolean', description: 'Filter by whether a pull request is linked.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const filtered = service.listTasks({
        ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
        ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
        ...(args.state === 'open' || args.state === 'closed' || args.state === 'all' ? { state: args.state } : {}),
        ...(typeof args.hasPr === 'boolean' ? { hasPr: args.hasPr } : {}),
      })
      return json({ tasks: filtered.map(task => githubTaskSummary(task)) })
    },
  })
}

function buildGetTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_get',
    description: 'Get full GitHub integration details for a task board card, including remote issue title, body, labels, pull request details, and synchronization state. Triggers: github get, github issue, 查看github任务, issue详情.',
    parameters: {
      taskId: { type: 'string', description: 'Task ID on the board.' },
      owner: { type: 'string', description: 'Repository owner (used with repository and issueNumber).' },
      repository: { type: 'string', description: 'Repository name (used with owner and issueNumber).' },
      issueNumber: { type: 'number', description: 'GitHub issue number.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      let task: TaskRecord | undefined
      if (typeof args.taskId === 'string' && args.taskId.trim() !== '') {
        task = service.host.tasks.get(args.taskId.trim())
      } else if (
        typeof args.owner === 'string'
        && typeof args.repository === 'string'
        && typeof args.issueNumber === 'number'
      ) {
        const o = args.owner.toLowerCase()
        const r = args.repository.toLowerCase()
        task = service.host.tasks.list().find(candidate => {
          const gh = readTaskGitHubMetadata(candidate)
          return gh !== undefined
            && gh.owner.toLowerCase() === o
            && gh.repository.toLowerCase() === r
            && gh.issueNumber === args.issueNumber
        })
      }
      const metadata = readTaskGitHubMetadata(task)
      if (task === undefined || metadata === undefined) {
        return refused('not-found', 'task with GitHub integration not found')
      }
      return json({
        ok: true,
        task: {
          taskId: task.id,
          title: task.title,
          description: task.description,
          prompt: task.prompt,
          status: task.status,
          archived: task.archivedAt !== undefined,
          github: metadata,
        },
      })
    },
  })
}

function buildRefreshTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_refresh',
    description: 'Trigger synchronization between GitHub issues/pull requests and the task board for a task, a repository, or all configured repositories. Triggers: github refresh, github sync, 刷新github, 同步github.',
    parameters: {
      taskId: { type: 'string', description: 'Specific task ID to refresh.' },
      owner: { type: 'string', description: 'Repository owner to refresh.' },
      repository: { type: 'string', description: 'Repository name to refresh.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (service.repositories.length === 0) {
        return refused('not-configured', 'GitHub integration is not configured')
      }
      try {
        if (typeof args.taskId === 'string' && args.taskId.trim() !== '') {
          const result = await service.syncTask(args.taskId.trim())
          if (!result.ok) return refused('sync-failed', result.error ?? 'sync failed')
          const updated = service.host.tasks.get(args.taskId.trim())
          return json({ ok: true, synced: 1, task: updated ? githubTaskSummary(updated) : undefined })
        } else if (typeof args.owner === 'string' && typeof args.repository === 'string') {
          const result = await service.syncRepository(args.owner.trim(), args.repository.trim())
          return json({ ok: true, synced: result.synced, errors: result.errors.length > 0 ? result.errors : undefined })
        } else {
          const result = await service.syncAll()
          return json({ ok: true, synced: result.synced, errors: result.errors.length > 0 ? result.errors : undefined })
        }
      } catch (error) {
        return refused('sync-error', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

function buildCreatePrTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_create_pr',
    description: 'Create a GitHub Pull Request for a task board card linked to a GitHub issue. Verifies that the head branch exists on remote, creates the PR, records PR metadata, and adds the PR phase label to the issue. Does not run shell commands. Triggers: github create pr, 创建PR, 开PR, pull request.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
      headBranch: { type: 'string', required: true, description: 'Remote head branch containing the changes (must already exist on remote).' },
      baseBranch: { type: 'string', description: 'Target base branch (default: repository default, e.g. main).' },
      title: { type: 'string', description: 'PR title (default: task title).' },
      body: { type: 'string', description: 'PR body text (default includes "Fixes #<issue>" and task description).' },
      draft: { type: 'boolean', description: 'Whether to create the PR as draft.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const task = service.host.tasks.get(args.taskId)
      if (readTaskGitHubMetadata(task) === undefined) {
        return refused('not-github-task', 'task is not linked to a GitHub issue')
      }
      try {
        const pr = await service.createPullRequest(args.taskId, {
          headBranch: args.headBranch,
          ...(args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.draft === undefined ? {} : { draft: args.draft }),
        })
        return json({ ok: true, pullRequest: pr })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('does not exist on remote')) {
          return refused('branch-not-found', message)
        }
        return refused('create-pr-failed', message)
      }
    },
  })
}

function buildLinkPrTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_link_pr',
    description: 'Link an existing GitHub Pull Request to a task board card linked to a GitHub issue, updating PR metadata and managed phase labels. Triggers: github link pr, 关联PR, 绑定PR.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
      pullRequestNumber: { type: 'number', required: true, description: 'Pull request number on GitHub.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const task = service.host.tasks.get(args.taskId)
      if (readTaskGitHubMetadata(task) === undefined) {
        return refused('not-github-task', 'task is not linked to a GitHub issue')
      }
      try {
        const pr = await service.linkPullRequest(args.taskId, args.pullRequestNumber)
        return json({ ok: true, pullRequest: pr })
      } catch (error) {
        return refused('link-pr-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
}
