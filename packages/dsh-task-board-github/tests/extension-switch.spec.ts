/**
 * The provider's master switch, end to end.
 *
 * The board gates a provider on its own master switch AND the provider's
 * `enabled()` (its registry's documented rule); the extension's own gate is
 * that it never admits itself while off and releases itself the moment the
 * switch flips. The fake board mirrors the board's rule, and the board's own
 * suite proves that rule against the real registry — together these cases pin
 * what an operator gets: no polling, no write-back, no tools, no seats, and no
 * data lost.
 */
import { describe, expect, it } from 'vitest'
import type {
  TaskBoardExtension,
  TaskBoardExtensionHost,
  TaskBoardHostFace,
} from '../src/core/contract.ts'
import type { GitHubRepoConfig } from '../src/core/types.ts'
import { GitHubApiClient } from '../src/host/client.ts'
import { createGitHubExtension } from '../src/host/extension.ts'
import { apply, Config } from '../src/index.ts'
import { installGitHubClientHalf } from '../src/client/github/extension.ts'
import { FakeBoard, recordingTimers } from './support/fake-board.ts'
import { FakeGitHubBackend, issueFixture } from './support/fake-github.ts'

const REPO: GitHubRepoConfig = { owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' }

/** Build a provider bound to a live switch the test can flip. */
function provider(options: {
  enabled: () => boolean
  board: FakeBoard
  backend: FakeGitHubBackend
  timers: ReturnType<typeof recordingTimers>['timers']
}): TaskBoardExtension {
  return createGitHubExtension({
    enabled: options.enabled,
    repositories: [REPO],
    client: new GitHubApiClient({ token: 'test-token', fetch: options.backend.fetch }),
    timers: options.timers,
    now: () => 100,
  })
}

/** A board host face that records every registration the extension makes. */
function recordingHostFace(): { face: TaskBoardHostFace; registered: TaskBoardExtension[]; releases: () => number } {
  const registered: TaskBoardExtension[] = []
  let releases = 0
  return {
    registered,
    releases: () => releases,
    face: {
      registerExtension(extension) {
        registered.push(extension)
        return () => { releases += 1 }
      },
      isExtensionEnabled: () => registered.length > 0,
    },
  }
}

describe('GitHub extension master switch', () => {
  it('operator with the extension switched off gets no provider surface and keeps the stored data', () => {
    // Given a board holding a synchronized card and a provider whose switch is off
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(10, ['dsh'])]
    const recorder = recordingTimers()
    const stored = board.seed({
      id: 'task-stored',
      title: 'Already synchronized',
      integrations: {
        github: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh',
          issueNumber: 10,
          issueUrl: 'https://github.com/deepseek-ai/dsh/issues/10',
          remoteLabels: ['dsh'],
        },
      },
    })
    const extension = provider({ enabled: () => false, board, backend, timers: recorder.timers })

    // When the board applies its own gate to the provider
    board.admit(extension)

    // Then nothing about the provider is running: no poll timer, no tool, no
    // published summary, no HTTP, and the switch reads off to the board
    expect(board.isActive('github')).toBe(false)
    expect(recorder.armed).toEqual([])
    expect(board.toolNames).toEqual([])
    expect(board.published).toEqual({})
    expect(backend.requests).toBe(0)
    expect(extension.enabled?.()).toBe(false)

    // And the data already on the board is untouched
    expect(board.records.get(stored.id)?.integrations).toEqual(stored.integrations)
  })

  it('operator switching the extension off after it ran stops polling, write-back and the tools', async () => {
    // Given a running provider with one synchronized card
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(20, ['dsh'])]
    const recorder = recordingTimers()
    let live = true
    const extension = provider({ enabled: () => live, board, backend, timers: recorder.timers })
    board.admit(extension)
    expect(board.isActive('github')).toBe(true)
    expect(board.toolNames).toHaveLength(5)
    expect(recorder.armed).toEqual([{ kind: 'interval', delay: 300_000 }])

    // When the operator turns the switch off and the board re-applies its gate
    live = false
    board.reconcile()

    // Then polling is released, the tools are unregistered, the published
    // summary clears, and a later status change no longer reaches GitHub
    expect(recorder.cancelledCount()).toBe(1)
    expect(board.toolNames).toEqual([])
    expect(board.published).toEqual({})
    const requestsWhileRunning = backend.requests
    board.emitStatusChanged({ taskId: 'task-stored', status: 'done', previous: 'todo' })
    expect(backend.requests).toBe(requestsWhileRunning)
  })

  it('operator switching the extension off releases the provider registration without a remount', () => {
    // Given a host context whose board service records registrations, and a
    // volatile switch the settings card commits in place
    let live = true
    const host = recordingHostFace()
    const listeners: Array<() => void> = []
    const ctx = {
      get: (name: string) => (name === 'taskBoard' ? host.face : undefined),
      on: (name: string, callback: () => void) => {
        if (name === 'loader/volatile-update') listeners.push(callback)
        return () => {}
      },
      effect: (callback: () => unknown) => callback(),
      provide: () => {},
    }
    const mounted = { ...Config({}), enabled: { get: () => live } }

    // When the row applies and the switch is flipped off and back on
    apply(ctx as never, mounted as never)
    expect(host.registered).toHaveLength(1)
    live = false
    for (const listener of listeners) listener()
    // Then the registration was released, so nothing of the provider is running
    expect(host.releases()).toBe(1)
    live = true
    for (const listener of listeners) listener()
    // And turning it back on admits a fresh provider under the same id
    expect(host.registered).toHaveLength(2)
    expect(host.registered[1]?.id).toBe('github')
    expect(host.registered[1]?.enabled?.()).toBe(true)
  })

  it('operator with the extension switched off sees the board provider seats unregistered', () => {
    // Given a board client service and a live switch the settings card commits
    let live = false
    const registered: Array<Record<string, unknown>> = []
    const visibility: unknown[] = []
    const seats = {
      register: (options: Record<string, unknown>) => {
        registered.push(options)
        return () => {
          const index = registered.indexOf(options)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    }
    const ctx = {
      get: (name: string) => (name === 'taskBoard' ? {
        dispatch: async () => true,
        registerVisibility: (predicate: unknown) => {
          visibility.push(predicate)
          return () => { visibility.splice(visibility.indexOf(predicate), 1) }
        },
        subscribe: () => () => {},
        snapshot: () => ({ enabled: true, tasks: [], extensions: {} }),
      } : undefined),
      slots: seats,
    }
    const listeners: Array<() => void> = []
    const source = {
      read: () => live,
      subscribe: (listener: () => void) => {
        listeners.push(listener)
        return () => {}
      },
    }

    // When the installer runs with the switch off, the operator turns it on,
    // and then turns it off again
    const dispose = installGitHubClientHalf(ctx as never, source)
    const whileOff = registered.length
    live = true
    for (const listener of listeners) listener()
    const whileOn = registered.length
    live = false
    for (const listener of listeners) listener()
    const afterTurningOff = registered.length
    dispose()
    const afterDispose = registered.length

    // Then no seat exists while off, all three exist while on, and both turning
    // the switch off and disposing release every one of them again
    expect(whileOff).toBe(0)
    expect(whileOn).toBe(3)
    expect(afterTurningOff).toBe(0)
    expect(afterDispose).toBe(0)
  })
})
