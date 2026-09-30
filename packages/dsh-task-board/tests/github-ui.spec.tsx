// @vitest-environment jsdom
/**
 * The GitHub surfaces of the task board as an operator sees them: the detail
 * panel's GitHub section, the board's search behaviour, and the way a
 * deactivated remote issue stops appearing in the active columns.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { TaskBoard, matchesFilter } from '../src/client/board/TaskBoard.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

/** One task record with the GitHub integration the case under test needs. */
function fakeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-gh-ui',
    title: 'GitHub UI Task',
    description: 'Detailed description',
    prompt: 'Prompt text',
    status: 'todo',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    executions: [],
    ...overrides,
  }
}

/** A controller double serving the given tasks (no host round trip). */
function fakeController(tasks: TaskRecord[]): BoardController {
  const state: ControllerSnapshot = {
    tasks,
    boardOpen: true,
    archiveView: false,
    selectedTaskId: tasks[0]?.id,
    executionOptions: { workspaces: [], presets: [] },
    pendingTaskIds: [],
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    closeTask: () => {},
    openTask: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    isHostBacked: () => true,
    refreshGitHub: async () => true,
    createGitHubPr: async () => true,
    linkGitHubPr: async () => true,
  } as unknown as BoardController
}

/** Render one element into a fresh container and return it. */
function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}

describe('GitHub UI integration', () => {
  it('operator reads the issue, its labels and its pull request from the task detail panel', () => {
    // Given a card backed by a GitHub issue carrying ten labels and an open draft PR
    const task = fakeTask({
      integrations: {
        github: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh',
          issueNumber: 123,
          issueUrl: 'https://github.com/deepseek-ai/dsh/issues/123',
          remoteState: 'open',
          remoteLabels: ['dsh', 'bug', 'frontend', 'p1', 'ready', 'docs', 'release', 'team:ui', 'label-9', 'label-10'],
          lastSyncedAt: 1_700_000_050_000,
          pullRequest: {
            number: 456,
            url: 'https://github.com/deepseek-ai/dsh/pull/456',
            state: 'open',
            draft: true,
            headBranch: 'feat/gh-integration',
            baseBranch: 'main',
          },
        },
      },
    })

    // When the detail panel renders it
    const container = render(<TaskDetail controller={fakeController([task])} task={task} />)

    // Then the GitHub section is anchored for skins, names the issue, and shows
    // every label (ten, i.e. beyond the native eight-tag limit) and the PR
    const section = container.querySelector('[data-dsh-part="github-integration"]')
    expect(section?.querySelector('[data-dsh-part="github-link"]')?.textContent).toContain('deepseek-ai/dsh #123')
    expect(section?.textContent).toContain('deepseek-ai/dsh')
    expect(section?.querySelectorAll('[data-dsh-part="github-label"]')).toHaveLength(10)
    const pull = section?.querySelector('[data-dsh-part="github-pr"]')
    expect(pull?.textContent).toContain('PR #456')
    expect(pull?.textContent).toContain('feat/gh-integration → main')
  })

  it('operator sees why a card whose issue lost the inclusion label is deactivated', () => {
    // Given an imported card whose remote issue dropped the inclusion label
    const task = fakeTask({
      integrations: {
        github: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh',
          issueNumber: 999,
          issueUrl: 'https://github.com/deepseek-ai/dsh/issues/999',
          remoteLabels: [],
          deactivated: true,
        },
      },
    })

    // When the detail panel renders it
    const container = render(<TaskDetail controller={fakeController([task])} task={task} />)

    // Then the panel explains the deactivation instead of looking broken
    const section = container.querySelector('[data-dsh-part="github-integration"]')
    expect(section?.textContent).toContain('该 Issue 在 GitHub 上已移除包含标签')
  })

  it('operator finds a card by its issue number, repository, owner or remote label', () => {
    // Given a card whose local text says nothing about its issue
    const task = fakeTask({
      title: 'Local title',
      description: 'Local desc',
      integrations: {
        github: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh-web',
          issueNumber: 1758,
          issueUrl: 'https://github.com/deepseek-ai/dsh-web/issues/1758',
          remoteLabels: ['priority:critical', 'ecosystem'],
        },
      },
    })

    // When the board filter is applied
    // Then the remote identifiers and labels are searchable, and unrelated text is not
    expect(matchesFilter(task, '1758')).toBe(true)
    expect(matchesFilter(task, '#1758')).toBe(true)
    expect(matchesFilter(task, 'dsh-web')).toBe(true)
    expect(matchesFilter(task, 'deepseek-ai')).toBe(true)
    expect(matchesFilter(task, 'priority:critical')).toBe(true)
    expect(matchesFilter(task, 'ecosystem')).toBe(true)
    expect(matchesFilter(task, 'unrelated-keyword')).toBe(false)
  })

  it('operator sees a deactivated issue leave the active board columns but a normal card stay', () => {
    // Given one ordinary card and one deactivated GitHub-backed card
    const activeTask = fakeTask({ id: 'active-1', title: 'Active Task' })
    const deactivatedTask = fakeTask({
      id: 'deactivated-1',
      title: 'Deactivated Task',
      integrations: {
        github: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh',
          issueNumber: 99,
          issueUrl: 'https://github.com/deepseek-ai/dsh/issues/99',
          remoteLabels: [],
          deactivated: true,
        },
      },
    })

    // When the board renders both
    const container = render(<TaskBoard controller={fakeController([activeTask, deactivatedTask])} />)

    // Then only the active card is on the board
    expect(container.textContent).toContain('Active Task')
    expect(container.textContent).not.toContain('Deactivated Task')
  })
})
