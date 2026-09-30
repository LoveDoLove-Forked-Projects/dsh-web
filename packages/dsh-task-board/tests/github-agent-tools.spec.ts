/**
 * The GitHub-specific Task Board agent tools. These are the model-visible
 * surface of the #1758 integration, now contributed by the GitHub provider
 * through the board's `registerTool` capability rather than by the board's own
 * agent-tools module, so each case asserts what the model can observe through a
 * tool call.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TASK_BOARD_TOOL_NAMES } from '../src/host/agent-tools.ts'
import { buildGitHubTools } from '../src/host/github/tools.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { GitHubSyncService } from '../src/host/github/service.ts'
import { GitHubApiClient } from '../src/host/github/client.ts'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { TaskBoardExtensionHost } from '../src/core/extension.ts'
import type { GitHubIssuePayload, GitHubPullRequestPayload } from '../src/core/github/types.ts'
import type { NewTaskInput } from '../src/core/tasks.ts'

const roots: string[] = []
let previousHome: string | undefined
let scratchHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-github-tools-home-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** The gateway face these tools never exercise (no session is ever started here). */
function fakeGateway(): TypertGateway {
  return {
    invoke: async () => ({ presets: [], items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/** Admit the GitHub extension and capture the capability face the board hands it. */
function admitGitHub(host: TaskBoardHostService): TaskBoardExtensionHost {
  let face: TaskBoardExtensionHost | undefined
  host.registerExtension({ id: 'github', apiVersion: 1, start: (capabilities) => { face = capabilities } })
  if (face === undefined) throw new Error('the board did not start the GitHub extension')
  return face
}

/** Locate one registered tool by name; a missing tool is a wiring failure. */
function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool
}

/** Run one tool with the given arguments and return its structured result. */
async function runTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

/** One GitHub-backed task input naming a repository and issue. */
function gitHubTaskInput(owner: string, repository: string, issueNumber: number): NewTaskInput {
  return {
    title: `${repository} issue ${String(issueNumber)}`,
    description: '',
    prompt: 'p',
    integrations: {
      github: {
        provider: 'github',
        owner,
        repository,
        issueNumber,
        issueUrl: `https://github.com/${owner}/${repository}/issues/${String(issueNumber)}`,
        remoteLabels: ['dsh'],
        remoteState: 'open',
      },
    },
  }
}

describe('GitHub Agent Tools', () => {
  it('operator sees the five GitHub tools contributed by the provider, separate from the board tool set', () => {
    // Given the board's own tool names and the provider's tool set
    // When both are read
    // Then the board no longer carries GitHub vocabulary, and the provider
    // contributes exactly its five narrowly-scoped tools
    expect(TASK_BOARD_TOOL_NAMES).not.toContain('task_board_github_list')
    const root = mkdtempSync(join(tmpdir(), 'dsh-gh-tools-'))
    roots.push(root)
    const ledger = new HostTaskLedger(root)
    const host = new TaskBoardHostService(fakeGateway(), { ledger })
    const service = new GitHubSyncService({ host: admitGitHub(host), repositories: [] })
    const names = buildGitHubTools(service).map(tool => tool.name)
    expect(names).toEqual([
      'task_board_github_list',
      'task_board_github_get',
      'task_board_github_refresh',
      'task_board_github_create_pr',
      'task_board_github_link_pr',
    ])
    host.dispose()
  })

  it('operator lists only GitHub-backed cards and can narrow by owner or remote state', async () => {
    // Given a board holding one plain card and two GitHub-backed cards
    const root = mkdtempSync(join(tmpdir(), 'dsh-gh-tools-'))
    roots.push(root)
    const ledger = new HostTaskLedger(root)
    const host = new TaskBoardHostService(fakeGateway(), { ledger })
    const face = admitGitHub(host)

    host.apply('c1', { kind: 'create', id: 'task-plain', input: { title: 'Plain task', description: '', prompt: 'p' } })
    host.apply('c2', { kind: 'create', id: 'task-gh-1', input: gitHubTaskInput('deepseek-ai', 'dsh', 1) })
    const second = gitHubTaskInput('other-org', 'other-repo', 2)
    ;(second.integrations!.github as Record<string, unknown>).remoteState = 'closed'
    host.apply('c3', { kind: 'create', id: 'task-gh-2', input: second })

    const service = new GitHubSyncService({ host: face, repositories: [] })
    const listTool = findTool(buildGitHubTools(service), 'task_board_github_list')

    // When the model lists them unfiltered, then by owner, then by state
    const all = await runTool(listTool, {})
    const byOwner = await runTool(listTool, { owner: 'deepseek-ai' })
    const byState = await runTool(listTool, { state: 'closed' })

    // Then the plain card is never included and each filter narrows correctly
    expect((all.tasks as unknown[]).length).toBe(2)
    expect((byOwner.tasks as Array<{ taskId: string }>).length).toBe(1)
    expect((byOwner.tasks as Array<{ taskId: string }>)[0]?.taskId).toBe('task-gh-1')
    expect((byState.tasks as Array<{ taskId: string }>).length).toBe(1)
    expect((byState.tasks as Array<{ taskId: string }>)[0]?.taskId).toBe('task-gh-2')

    host.dispose()
  })

  it('operator reads one GitHub card by task id or by repository and issue number', async () => {
    // Given a board holding one GitHub-backed card
    const root = mkdtempSync(join(tmpdir(), 'dsh-gh-tools-'))
    roots.push(root)
    const ledger = new HostTaskLedger(root)
    const host = new TaskBoardHostService(fakeGateway(), { ledger })
    const face = admitGitHub(host)
    host.apply('c1', { kind: 'create', id: 'task-10', input: gitHubTaskInput('deepseek-ai', 'dsh', 10) })

    const service = new GitHubSyncService({ host: face, repositories: [] })
    const getTool = findTool(buildGitHubTools(service), 'task_board_github_get')

    // When the model looks it up by task id, then by the stable triple, then by a missing id
    const byId = await runTool(getTool, { taskId: 'task-10' })
    const byTriple = await runTool(getTool, { owner: 'deepseek-ai', repository: 'dsh', issueNumber: 10 })
    const missing = await runTool(getTool, { taskId: 'non-existent' })

    // Then the same card answers both lookups and an unknown id is refused
    expect(byId.ok).toBe(true)
    expect((byId.task as { title: string }).title).toBe('dsh issue 10')
    expect((byId.task as { github: { issueNumber: number } }).github.issueNumber).toBe(10)
    expect(byTriple.ok).toBe(true)
    expect((byTriple.task as { taskId: string }).taskId).toBe('task-10')
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not-found')

    host.dispose()
  })

  it('operator creates and links a pull request only through the configured repository', async () => {
    // Given a configured repository whose branch list and PR endpoints answer deterministically
    const root = mkdtempSync(join(tmpdir(), 'dsh-gh-tools-'))
    roots.push(root)
    const ledger = new HostTaskLedger(root)

    const issue: GitHubIssuePayload = {
      number: 40,
      title: 'PR Tool Task',
      body: 'Task for PR tool testing',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/40',
      labels: ['dsh'],
      updated_at: '2026-09-02T10:00:00Z',
    }
    const existingPull: GitHubPullRequestPayload = {
      number: 99,
      html_url: 'https://github.com/deepseek-ai/dsh/pull/99',
      state: 'open',
      head: { ref: 'existing-branch' },
      base: { ref: 'main' },
    }
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      const method = init?.method ?? 'GET'
      if (url.pathname.includes('/branches/feature%2Fpr-40') || url.pathname.includes('/branches/feature/pr-40')) {
        return new Response(JSON.stringify({ name: 'feature/pr-40', commit: { sha: '123' } }), { status: 200 })
      }
      if (url.pathname.includes('/branches/missing-branch')) return new Response('Not found', { status: 404 })
      if (url.pathname.endsWith('/pulls') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { draft?: boolean, head: string, base: string }
        return new Response(JSON.stringify({
          number: 55,
          html_url: 'https://github.com/deepseek-ai/dsh/pull/55',
          state: 'open',
          draft: body.draft ?? false,
          head: { ref: body.head },
          base: { ref: body.base },
        }), { status: 201 })
      }
      if (url.pathname.includes('/pulls/99')) return new Response(JSON.stringify(existingPull), { status: 200 })
      if (url.pathname.includes('/labels')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.pathname.includes('/issues/40')) return new Response(JSON.stringify(issue), { status: 200 })
      return new Response('Not found', { status: 404 })
    }

    const client = new GitHubApiClient({ token: 'test-token', fetch: fakeFetch })
    const host = new TaskBoardHostService(fakeGateway(), { ledger })
    const face = admitGitHub(host)
    const service = new GitHubSyncService({
      host: face,
      client,
      repositories: [{ owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' }],
    })
    host.apply('c1', { kind: 'create', id: 'task-40', input: gitHubTaskInput('deepseek-ai', 'dsh', 40) })

    const tools = buildGitHubTools(service)
    const createPrTool = findTool(tools, 'task_board_github_create_pr')
    const linkPrTool = findTool(tools, 'task_board_github_link_pr')
    const refreshTool = findTool(tools, 'task_board_github_refresh')

    // When the model asks for a PR on a branch that does not exist remotely
    const branchMissing = await runTool(createPrTool, { taskId: 'task-40', headBranch: 'missing-branch' })
    // Then the operation is refused with the domain reason
    expect(branchMissing.ok).toBe(false)
    expect(branchMissing.code).toBe('branch-not-found')

    // When it asks again on a branch that does exist
    const created = await runTool(createPrTool, { taskId: 'task-40', headBranch: 'feature/pr-40' })
    // Then a PR is created and reported
    expect(created.ok).toBe(true)
    expect((created.pullRequest as { number: number }).number).toBe(55)

    // When it links an existing PR by number
    const linked = await runTool(linkPrTool, { taskId: 'task-40', pullRequestNumber: 99 })
    // Then that PR is attached to the card
    expect(linked.ok).toBe(true)
    expect((linked.pullRequest as { number: number }).number).toBe(99)

    // When it refreshes the card from GitHub
    const refreshed = await runTool(refreshTool, { taskId: 'task-40' })
    // Then the refresh is accepted
    expect(refreshed.ok).toBe(true)

    host.dispose()
  })
})
