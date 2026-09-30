/**
 * The Host-side GitHub synchronization loop, driven against an in-process
 * GitHub stand-in. Each case drives the real GitHubSyncService and then reads
 * the ledger (or the fake remote) back, so the assertions are about what an
 * operator ends up with rather than about internal calls.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardExtensionRegistry } from '../src/host/extension-registry.ts'
import { GitHubSyncService } from '../src/host/github/service.ts'
import { GitHubApiClient } from '../src/host/github/client.ts'
import type { HostTimerFace } from '../src/host-service.ts'
import { readTaskGitHubMetadata, type GitHubIssuePayload, type GitHubPullRequestPayload } from '../src/core/github/types.ts'
import type { TaskBoardExtensionHost } from '../src/core/extension.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardSnapshot } from '../src/protocol.ts'
import { startExecution } from '../src/core/tasks.ts'

/** A throwaway Host ledger plus its cleanup. */
function makeTempLedger(): { ledger: HostTaskLedger, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-github-test-'))
  const ledger = new HostTaskLedger(dir, () => 1_000)
  return { ledger, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/**
 * Build the capability face the board would hand the GitHub extension, backed
 * by the real registry and ledger so every board gate stays in the path.
 */
function makeHost(ledger: HostTaskLedger): TaskBoardExtensionHost {
  const apply = (action: Exclude<TaskBoardAction, { kind: 'extension-action' }>, initiator?: string): TaskBoardSnapshot => {
    const result = ledger.applyRequest(crypto.randomUUID(), action, initiator)
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: result.state.revision,
      tasks: result.state.tasks,
      scheduler: result.state.scheduler,
      power: { platform: 'test', phase: 'disabled', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    }
  }
  const registry = new TaskBoardExtensionRegistry({ ledger, apply })
  let host: TaskBoardExtensionHost | undefined
  registry.registerExtension({ id: 'github', apiVersion: 1, start: face => { host = face } })
  if (host === undefined) throw new Error('capability host was not started')
  return host
}

/** The repository every case configures. */
const REPO = { owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' }

/**
 * In-process GitHub REST stand-in covering exactly the endpoints the sync
 * service calls: issue listing and lookup, label add/remove, branch lookup,
 * PR creation and lookup, and issue state patching.
 */
class FakeGitHubBackend {
  issues: GitHubIssuePayload[] = []
  pulls: GitHubPullRequestPayload[] = []
  branches: string[] = []
  networkFailure = false

  fetch: typeof fetch = async (input, init) => {
    if (this.networkFailure) throw new Error('Network error: ETIMEDOUT')
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? 'GET'
    const pathname = url.pathname

    if (pathname.includes('/issues') && method === 'GET' && !pathname.match(/\/issues\/\d+$/)) {
      return json(this.issues)
    }
    const issueMatch = pathname.match(/\/issues\/(\d+)$/)
    if (issueMatch && method === 'GET') {
      const found = this.issues.find(candidate => candidate.number === Number(issueMatch[1]))
      return found === undefined ? new Response('Not found', { status: 404 }) : json(found)
    }
    if (issueMatch && method === 'PATCH') {
      const found = this.issues.find(candidate => candidate.number === Number(issueMatch[1]))
      if (found === undefined) return new Response('Not found', { status: 404 })
      const body = JSON.parse(String(init?.body)) as { state?: 'open' | 'closed' }
      if (body.state !== undefined) found.state = body.state
      return json(found)
    }
    const labelsMatch = pathname.match(/\/issues\/(\d+)\/labels$/)
    if (labelsMatch && method === 'POST') {
      const found = this.issues.find(candidate => candidate.number === Number(labelsMatch[1]))
      if (found === undefined) return new Response('Not found', { status: 404 })
      const body = JSON.parse(String(init?.body)) as { labels: string[] }
      const existing = nameOf(found.labels)
      for (const label of body.labels) if (!existing.includes(label)) existing.push(label)
      found.labels = existing
      return json(existing)
    }
    const delLabelMatch = pathname.match(/\/issues\/(\d+)\/labels\/(.+)$/)
    if (delLabelMatch && method === 'DELETE') {
      const found = this.issues.find(candidate => candidate.number === Number(delLabelMatch[1]))
      if (found !== undefined) {
        const target = decodeURIComponent(delLabelMatch[2])
        found.labels = nameOf(found.labels).filter(label => label !== target)
      }
      return new Response(null, { status: 204 })
    }
    const branchMatch = pathname.match(/\/branches\/(.+)$/)
    if (branchMatch && method === 'GET') {
      const branchName = decodeURIComponent(branchMatch[1])
      return this.branches.includes(branchName)
        ? json({ name: branchName, commit: { sha: 'abc1234' } })
        : new Response('Branch not found', { status: 404 })
    }
    if (pathname.includes('/pulls') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { draft?: boolean, head: string, base: string }
      const number = this.pulls.length + 1
      const pull: GitHubPullRequestPayload = {
        number,
        html_url: `https://github.com/deepseek-ai/dsh/pull/${String(number)}`,
        state: 'open',
        draft: body.draft ?? false,
        head: { ref: body.head },
        base: { ref: body.base },
      }
      this.pulls.push(pull)
      return json(pull, 201)
    }
    const pullMatch = pathname.match(/\/pulls\/(\d+)$/)
    if (pullMatch && method === 'GET') {
      const found = this.pulls.find(candidate => candidate.number === Number(pullMatch[1]))
      return found === undefined ? new Response('Not found', { status: 404 }) : json(found)
    }
    return new Response('Unhandled endpoint', { status: 500 })
  }

  /** The label names currently on one issue. */
  labelsOf(issueNumber: number): string[] {
    return nameOf(this.issues.find(candidate => candidate.number === issueNumber)?.labels ?? [])
  }

  /** The state of one issue. */
  stateOf(issueNumber: number): string {
    return this.issues.find(candidate => candidate.number === issueNumber)?.state ?? 'unknown'
  }
}

/** A JSON response with the GitHub content type. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** The label names carried by an issue payload. */
function nameOf(labels: GitHubIssuePayload['labels']): string[] {
  return labels.map(label => (typeof label === 'string' ? label : label.name))
}

/** One open issue fixture carrying the given labels and body. */
function issueFixture(number: number, labels: string[], body = ''): GitHubIssuePayload {
  return {
    number,
    title: `Issue ${String(number)}`,
    body,
    state: 'open',
    html_url: `https://github.com/deepseek-ai/dsh/issues/${String(number)}`,
    labels,
    updated_at: '2026-09-02T10:00:00Z',
  }
}
describe('GitHub sync service (issue #1758)', () => {
  it('operator sees an issue carrying the inclusion label imported once and reconciled on every later sync', async () => {
    // Given a repository with one includable issue and one that lacks the label
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(10, ['dsh', 'bug'], 'Issue 10 description'), issueFixture(11, ['feature'])]
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })

    // When the repository is synchronized
    const first = await service.syncRepository('deepseek-ai', 'dsh')

    // Then only the labeled issue is materialized, carrying its remote metadata
    expect(first.synced).toBe(1)
    expect(ledger.allTasks()).toHaveLength(1)
    const task = ledger.allTasks()[0]
    expect(readTaskGitHubMetadata(task)?.issueNumber).toBe(10)
    expect(readTaskGitHubMetadata(task)?.remoteLabels).toEqual(['dsh', 'bug'])
    // And its GitHub labels never leak into the native tag list
    expect(task?.tags).toBeUndefined()

    // When the same repository is synchronized again
    const second = await service.syncRepository('deepseek-ai', 'dsh')

    // Then the same card is reconciled rather than duplicated
    expect(second.synced).toBe(1)
    expect(ledger.allTasks()).toHaveLength(1)
    expect(ledger.allTasks()[0]?.id).toBe(task?.id)

    cleanup()
  })

  it('operator removing the inclusion label keeps the card and its execution history until it returns', async () => {
    // Given an imported card that has already run to success
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(25, ['dsh'])]
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!
    ledger.saveTaskRecord(startExecution(task, 150, 'exec-1').task)
    ledger.settle(task.id, 'exec-1', 'succeeded')
    expect(ledger.getTask(task.id)?.executions).toHaveLength(1)

    // When the inclusion label is removed on GitHub and the repository is synchronized
    backend.issues[0]!.labels = ['some-other-label']
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then the card is deactivated, not deleted, and its history survives
    const deactivated = ledger.getTask(task.id)
    expect(readTaskGitHubMetadata(deactivated)?.deactivated).toBe(true)
    expect(deactivated?.executions).toHaveLength(1)
    expect(deactivated?.executions[0]?.result).toBe('succeeded')

    // When the label is added back and the repository is synchronized again
    backend.issues[0]!.labels = ['dsh', 'some-other-label']
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then the same card is restored with its history intact
    const restored = ledger.getTask(task.id)
    expect(readTaskGitHubMetadata(restored)?.deactivated).toBeUndefined()
    expect(restored?.executions).toHaveLength(1)

    cleanup()
  })

  it('operator sees a card keep its execution prompt when the remote issue changes after the first run', async () => {
    // Given an imported card whose prompt came from the issue body
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(50, ['dsh'], 'Initial Prompt Content')]
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!
    expect(task.prompt).toBe('Initial Prompt Content')

    // And the card has started executing
    ledger.saveTaskRecord(startExecution(task, 150, 'exec-50').task)

    // When the remote title and body are edited on GitHub
    backend.issues[0]!.title = 'Changed Title'
    backend.issues[0]!.body = 'Changed Remote Body'
    backend.issues[0]!.updated_at = '2026-09-02T11:00:00Z'
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then the historical prompt and title are unchanged while the remote
    // snapshot is recorded as provider metadata only
    const stored = ledger.getTask(task.id)!
    expect(stored.prompt).toBe('Initial Prompt Content')
    expect(stored.title).toBe('Issue 50')
    expect(readTaskGitHubMetadata(stored)?.remoteTitle).toBe('Changed Title')
    expect(readTaskGitHubMetadata(stored)?.remoteBody).toBe('Changed Remote Body')

    cleanup()
  })

  it('operator moving a card writes back only DSH-owned labels and leaves repository labels alone', async () => {
    // Given an imported issue carrying repository labels
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(77, ['dsh', 'bug', 'priority:p0', 'team:core'])]
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!

    // When the card is moved to running
    await service.writeBackTaskStatus(task.id, 'running')

    // Then the DSH state label is added and every repository label survives
    const running = backend.labelsOf(77)
    expect(running).toContain('dsh:state:running')
    expect(running).toContain('bug')
    expect(running).toContain('priority:p0')
    expect(running).toContain('team:core')

    // When the card settles as done
    await service.writeBackTaskStatus(task.id, 'done')

    // Then the old state label is replaced and the repository labels are still untouched
    const done = backend.labelsOf(77)
    expect(done).toContain('dsh:state:done')
    expect(done).not.toContain('dsh:state:running')
    expect(done).toContain('bug')
    expect(done).toContain('priority:p0')
    expect(done).toContain('team:core')

    cleanup()
  })

  it('operator keeps working locally while GitHub is unreachable, and the failure is reported', async () => {
    // Given a GitHub backend that times out
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.networkFailure = true
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })

    // When a sync runs
    const result = await service.syncRepository('deepseek-ai', 'dsh')

    // Then the failure is reported back rather than thrown at the local runtime
    expect(result.synced).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('ETIMEDOUT')

    cleanup()
  })

  it('operator creates a pull request only for a branch that already exists remotely', async () => {
    // Given an imported issue and a repository whose only remote branch is feature-88
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(88, ['dsh'], 'Implement PR')]
    backend.branches = ['feature-88']
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [REPO],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!

    // When a PR is requested for a branch that is not on the remote
    // Then the request is refused with the reason, and no PR is recorded
    await expect(service.createPullRequest(task.id, { headBranch: 'non-existent-branch' }))
      .rejects.toThrow('branch "non-existent-branch" does not exist on remote')
    expect(backend.pulls).toHaveLength(0)

    // When a PR is requested for the existing branch as a draft
    const pull = await service.createPullRequest(task.id, { headBranch: 'feature-88', draft: true })

    // Then the PR is created as a draft, recorded on the card, and the remote
    // issue picks up the PR phase label
    expect(pull.number).toBe(1)
    expect(pull.draft).toBe(true)
    expect(backend.labelsOf(88)).toContain('dsh:phase:pr')
    const updated = ledger.getTask(task.id)!
    expect(readTaskGitHubMetadata(updated)?.pullRequest?.number).toBe(1)
    expect(readTaskGitHubMetadata(updated)?.pullRequest?.state).toBe('open')

    cleanup()
  })

  it('operator sees a merged pull request settle the card and close the issue when that policy is on', async () => {
    // Given a configured repository that closes the issue on merge, with a PR open
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(90, ['dsh'])]
    backend.branches = ['branch-90']
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [{ ...REPO, closeIssueOnMerge: true }],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!
    await service.createPullRequest(task.id, { headBranch: 'branch-90' })

    // When the PR is merged on GitHub and the repository is synchronized
    backend.pulls[0]!.merged = true
    backend.pulls[0]!.state = 'closed'
    backend.pulls[0]!.merged_at = '2026-09-02T12:00:00Z'
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then the card records the merged PR, drops the PR phase label, gains the
    // done state label, and the issue is closed
    const settled = ledger.getTask(task.id)!
    expect(readTaskGitHubMetadata(settled)?.pullRequest?.state).toBe('merged')
    const labels = backend.labelsOf(90)
    expect(labels).not.toContain('dsh:phase:pr')
    expect(labels).toContain('dsh:state:done')
    expect(backend.stateOf(90)).toBe('closed')
    expect(readTaskGitHubMetadata(settled)?.remoteState).toBe('closed')

    cleanup()
  })

  it('operator sees an abandoned pull request leave the issue open and the card reconciled', async () => {
    // Given a repository that closes the issue on merge, with a PR open
    const { ledger, cleanup } = makeTempLedger()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(95, ['dsh'])]
    backend.branches = ['branch-95']
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      repositories: [{ ...REPO, closeIssueOnMerge: true }],
      now: () => 100,
    })
    await service.syncRepository('deepseek-ai', 'dsh')
    const task = ledger.allTasks()[0]!
    await service.createPullRequest(task.id, { headBranch: 'branch-95' })

    // When the PR is closed without being merged
    backend.pulls[0]!.merged = false
    backend.pulls[0]!.state = 'closed'
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then the card reports the closed PR while the issue stays open
    const settled = ledger.getTask(task.id)!
    expect(readTaskGitHubMetadata(settled)?.pullRequest?.state).toBe('closed')
    expect(backend.stateOf(95)).toBe('open')
    expect(readTaskGitHubMetadata(settled)?.remoteState).toBe('open')

    cleanup()
  })

  it('operator gets background polling on the configured interval, independent of the session heartbeat', () => {
    // Given a repository configured to poll every 60 seconds
    const { ledger, cleanup } = makeTempLedger()
    let armedIntervalMs: number | undefined
    let cancelled = false
    const timers: HostTimerFace = {
      timeout: () => () => {},
      interval: (_callback, delay) => {
        armedIntervalMs = delay
        return () => { cancelled = true }
      },
    }
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'test-token', fetch: async () => json([]) }),
      repositories: [{ ...REPO, pollingIntervalMs: 60_000 }],
      timers,
    })

    // When polling starts and then stops
    service.start()
    // Then the timer carries the configured interval, not the 5 s runtime heartbeat
    expect(armedIntervalMs).toBe(60_000)
    service.stop()
    // And stopping releases the timer
    expect(cancelled).toBe(true)

    cleanup()
  })

  it('operator sees the GitHub summary report credential presence without ever carrying the token', () => {
    // Given a service holding a credential
    const { ledger, cleanup } = makeTempLedger()
    const service = new GitHubSyncService({
      host: makeHost(ledger),
      client: new GitHubApiClient({ token: 'super-secret-token' }),
      repositories: [REPO],
    })

    // When the summary the browser/agent may read is produced
    const summary = service.snapshotSummary()

    // Then it reports that a credential exists and which repositories are
    // configured, and the token value appears nowhere in it
    expect(summary.hasCredential).toBe(true)
    expect(summary.repositories).toHaveLength(1)
    expect(summary.repositories[0]?.owner).toBe('deepseek-ai')
    expect(JSON.stringify(summary)).not.toContain('super-secret-token')

    cleanup()
  })
})
