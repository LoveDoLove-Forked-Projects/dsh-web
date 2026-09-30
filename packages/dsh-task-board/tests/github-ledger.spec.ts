/**
 * The GitHub provider metadata is additive on TaskRecord, so it must survive a
 * ledger round-trip without a schema migration and without disturbing a task
 * that carries none. These cases drive the real persistence seam: create a
 * task through the service, read the on-disk document back, and re-parse it the
 * way the Host does at startup.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLedger } from '../src/core/store.ts'
import { readTaskGitHubMetadata } from '../src/core/github/types.ts'
import type { TaskRecord } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TASK_BOARD_SCHEMA_VERSION } from '../src/protocol.ts'

/** A throwaway Host ledger directory plus its cleanup. */
function makeTempLedger(): { dir: string, ledger: HostTaskLedger, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-github-ledger-'))
  const ledger = new HostTaskLedger(dir, () => 1_000)
  return { dir, ledger, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/** A minimal local task record with no integrations. */
function baseTask(id: string, title: string): TaskRecord {
  return { id, title, description: '', prompt: 'p', status: 'todo', createdAt: 1_000, updatedAt: 1_000, executions: [] }
}

/** The GitHub metadata a synchronized card carries. */
const INTEGRATION = {
  github: {
    provider: 'github' as const,
    owner: 'deepseek-ai',
    repository: 'dsh',
    issueNumber: 1758,
    issueUrl: 'https://github.com/deepseek-ai/dsh/issues/1758',
    remoteLabels: ['dsh', 'enhancement'],
    remoteState: 'open' as const,
    pullRequest: {
      number: 42,
      url: 'https://github.com/deepseek-ai/dsh/pull/42',
      state: 'open' as const,
      draft: true,
      headBranch: 'feat/gh',
      baseBranch: 'main',
    },
  },
}

/** The absolute path of the ledger document inside a ledger directory. */
function ledgerFile(dir: string): string {
  return join(dir, 'ledger-v2.json')
}

/** The Host document as written to disk. */
function readDocument(dir: string): { schemaVersion: number, tasks: unknown[] } {
  return JSON.parse(readFileSync(ledgerFile(dir), 'utf8')) as { schemaVersion: number, tasks: unknown[] }
}

/** Re-parse the persisted task array the way the Host does at startup. */
function reopen(dir: string): ReturnType<typeof parseLedger> {
  return parseLedger(JSON.stringify(readDocument(dir).tasks))
}

describe('GitHub metadata persistence (issue #1758)', () => {
  it('operator restarting the Host keeps the GitHub metadata on a synchronized card', () => {
    // Given a card carrying GitHub provider metadata
    const { dir, ledger, cleanup } = makeTempLedger()
    ledger.saveTaskRecord({ ...baseTask('task-gh', 'Sync me'), integrations: INTEGRATION })

    // When the on-disk ledger document is re-read the way the Host does at startup
    const restored = reopen(dir)

    // Then the card comes back with its stable identity, labels and PR intact
    const task = restored.find(candidate => candidate.id === 'task-gh')
    const metadata = readTaskGitHubMetadata(task)
    expect(metadata?.issueNumber).toBe(1758)
    expect(metadata?.remoteLabels).toEqual(['dsh', 'enhancement'])
    expect(metadata?.pullRequest?.number).toBe(42)
    expect(metadata?.pullRequest?.draft).toBe(true)
    expect(metadata?.pullRequest?.headBranch).toBe('feat/gh')

    cleanup()
  })

  it('operator keeps a plain local card unchanged and the ledger version untouched', () => {
    // Given a card with no integrations at all
    const { dir, ledger, cleanup } = makeTempLedger()
    ledger.saveTaskRecord(baseTask('task-plain', 'Plain'))

    // When the document is written and re-read
    const document = readDocument(dir)
    const restored = reopen(dir)

    // Then the card carries no integrations and the schema stays additive,
    // so no migration is required for existing ledgers
    expect(restored.find(candidate => candidate.id === 'task-plain')?.integrations).toBeUndefined()
    expect(document.schemaVersion).toBe(TASK_BOARD_SCHEMA_VERSION)

    cleanup()
  })

  it('operator sees a malformed persisted integrations container dropped instead of the whole card', () => {
    // Given an on-disk document whose integrations container repairs to
    // nothing (the board no longer validates provider vocabulary, so an empty
    // container is simply dropped; a non-object value would drop the row, which
    // the shape gate owns)
    const { dir, ledger, cleanup } = makeTempLedger()
    ledger.saveTaskRecord({ ...baseTask('task-gh', 'Sync me'), integrations: INTEGRATION })
    const document = readDocument(dir)
    const row = document.tasks.find(candidate => (candidate as { id?: string }).id === 'task-gh') as Record<string, unknown>
    row.integrations = {}
    writeFileSync(ledgerFile(dir), JSON.stringify(document))

    // When the document is re-read
    const restored = reopen(dir)

    // Then the card survives with the unusable container dropped, rather than
    // taking the whole ledger row down
    const task = restored.find(candidate => candidate.id === 'task-gh')
    expect(task?.title).toBe('Sync me')
    expect(task?.integrations).toBeUndefined()

    cleanup()
  })
})
