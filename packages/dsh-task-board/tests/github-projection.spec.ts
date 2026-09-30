/**
 * Pure projection and lifecycle mapping for the GitHub task-board integration.
 *
 * These cases pin the two contracts the integration exists to keep honest:
 * only DSH-owned labels are ever written back to GitHub, and a task that has
 * started executing can never have its historical prompt rewritten by a remote
 * issue edit.
 */
import { describe, expect, it } from 'vitest'
import {
  computeLabelWriteBack,
  isDshManagedLabel,
  materializeTaskFromIssue,
  reconcileIssueWithTask,
  resolveStatusFromLabels,
  shouldRefreshContent,
} from '../src/core/github/projection.ts'
import {
  normalizeIntegrations,
  resolveRepoConfig,
  type GitHubIssuePayload,
  type ResolvedGitHubRepoConfig,
} from '../src/core/github/types.ts'
import { createTask, startExecution } from '../src/core/tasks.ts'

const sampleConfig: ResolvedGitHubRepoConfig = resolveRepoConfig({
  owner: 'deepseek-ai',
  repository: 'dsh',
  inclusionLabel: 'dsh',
  managedLabelPrefix: 'dsh:',
  prPhaseLabel: 'dsh:phase:pr',
})

describe('GitHub projection & label management', () => {
  it('operator sees DSH-owned labels recognized and the inclusion label left alone', () => {
    // Given a repository whose managed prefix, state labels and PR phase label are configured
    // When each label is classified for DSH ownership
    // Then the managed ones are owned, and the inclusion label is not, so write-back
    // never removes the very label that selects the issue
    expect(isDshManagedLabel('dsh:state:todo', sampleConfig)).toBe(true)
    expect(isDshManagedLabel('dsh:state:done', sampleConfig)).toBe(true)
    expect(isDshManagedLabel('dsh:phase:pr', sampleConfig)).toBe(true)
    expect(isDshManagedLabel('dsh:custom', sampleConfig)).toBe(true)
    expect(isDshManagedLabel('bug', sampleConfig)).toBe(false)
    expect(isDshManagedLabel('security', sampleConfig)).toBe(false)
    expect(isDshManagedLabel('priority:high', sampleConfig)).toBe(false)
    expect(isDshManagedLabel('dsh', sampleConfig)).toBe(false)
  })

  it('operator moving a card writes back only DSH-owned labels and leaves repository labels intact', () => {
    // Given an issue carrying repository labels, the inclusion label and a stale state label
    const current = ['bug', 'security', 'dsh', 'dsh:state:todo', 'priority:high']

    // When the card moves to done
    const { labelsToAdd, labelsToRemove } = computeLabelWriteBack(current, 'done', false, sampleConfig)

    // Then only the DSH state label changes, and the repository labels are never touched
    expect(labelsToRemove).toEqual(['dsh:state:todo'])
    expect(labelsToAdd).toEqual(['dsh:state:done'])
    expect(labelsToRemove).not.toContain('bug')
    expect(labelsToRemove).not.toContain('security')
    expect(labelsToRemove).not.toContain('priority:high')
    expect(labelsToRemove).not.toContain('dsh')
  })

  it('operator with an active pull request sees the PR phase label added and removed with the PR', () => {
    // Given an issue whose card is running with no PR yet
    const current = ['bug', 'dsh', 'dsh:state:todo']

    // When the PR becomes active
    const withPr = computeLabelWriteBack(current, 'running', true, sampleConfig)

    // Then both the state label and the PR phase label are added
    expect(withPr.labelsToAdd).toContain('dsh:state:running')
    expect(withPr.labelsToAdd).toContain('dsh:phase:pr')

    // When the PR settles, the phase label and the stale state label are removed
    const prActiveLabels = ['bug', 'dsh', 'dsh:state:running', 'dsh:phase:pr']
    const prSettled = computeLabelWriteBack(prActiveLabels, 'done', false, sampleConfig)
    expect(prSettled.labelsToRemove).toContain('dsh:state:running')
    expect(prSettled.labelsToRemove).toContain('dsh:phase:pr')
    expect(prSettled.labelsToAdd).toEqual(['dsh:state:done'])
  })

  it('operator importing an issue sees its remote state project onto a board column', () => {
    // Given issues carrying various remote states and DSH state labels
    // When each is projected into the local board
    // Then the remote closed state and the managed state labels decide the column
    expect(resolveStatusFromLabels(['bug', 'dsh'], 'open', sampleConfig)).toBe('todo')
    expect(resolveStatusFromLabels(['bug', 'dsh:state:backlog'], 'open', sampleConfig)).toBe('backlog')
    expect(resolveStatusFromLabels(['dsh:state:failed'], 'open', sampleConfig)).toBe('failed')
    expect(resolveStatusFromLabels(['dsh:state:done'], 'open', sampleConfig)).toBe('done')
    expect(resolveStatusFromLabels(['bug'], 'closed', sampleConfig)).toBe('done')
  })

  it('operator sees an executed task keep its prompt frozen against remote edits', () => {
    // Given a task that has never executed and one whose execution has started
    const unexecuted = createTask({ title: 'T', description: 'D', prompt: 'Initial prompt' }, 1, 'task-1')
    const { task: executed } = startExecution(unexecuted, 10, 'exec-1')

    // When each is asked whether remote content may refresh it
    // Then only the unexecuted one may, so the historical prompt is never rewritten
    expect(shouldRefreshContent(unexecuted)).toBe(true)
    expect(shouldRefreshContent(executed)).toBe(false)
  })

  it('operator sees a running task keep its historical prompt while remote metadata still updates', () => {
    // Given a task whose execution has started
    const task = createTask({ title: 'Old Title', description: 'Old Desc', prompt: 'Historical Prompt' }, 1, 'task-1')
    const { task: runningTask } = startExecution(task, 10, 'exec-1')
    const remotePayload: GitHubIssuePayload = {
      number: 101,
      title: 'New Remote Title',
      body: 'New Remote Body',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/101',
      labels: ['bug', 'dsh'],
      updated_at: '2026-09-02T12:00:00Z',
    }

    // When the issue is reconciled against it
    const reconciled = reconcileIssueWithTask(runningTask, remotePayload, 20, sampleConfig)

    // Then the execution prompt survives while the remote metadata is refreshed
    expect(reconciled.title).toBe('Old Title')
    expect(reconciled.description).toBe('Old Desc')
    expect(reconciled.prompt).toBe('Historical Prompt')
    expect(reconciled.integrations?.github?.remoteTitle).toBe('New Remote Title')
    expect(reconciled.integrations?.github?.remoteBody).toBe('New Remote Body')
    expect(reconciled.integrations?.github?.issueNumber).toBe(101)
    expect(reconciled.integrations?.github?.lastSyncedAt).toBe(20)
  })

  it('operator sees an unexecuted task adopt the remote title and body on sync', () => {
    // Given a task that has never executed
    const task = createTask({ title: 'Initial Title', description: 'Initial Desc', prompt: 'Initial Prompt' }, 1, 'task-1')
    const remotePayload: GitHubIssuePayload = {
      number: 101,
      title: 'Updated Remote Title',
      body: 'Updated Remote Body',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/101',
      labels: ['bug', 'dsh'],
      updated_at: '2026-09-02T12:00:00Z',
    }

    // When the issue is reconciled against it
    const reconciled = reconcileIssueWithTask(task, remotePayload, 20, sampleConfig)

    // Then the local snapshot follows the remote content
    expect(reconciled.title).toBe('Updated Remote Title')
    expect(reconciled.description).toBe('Updated Remote Body')
    expect(reconciled.prompt).toBe('Updated Remote Body')
  })

  it('operator removing the inclusion label keeps the task and its history until it returns', () => {
    // Given an imported task whose issue carries the inclusion label
    const task = createTask({ title: 'Task', description: 'Desc', prompt: 'Prompt' }, 1, 'task-1')
    const withoutInclusion: GitHubIssuePayload = {
      number: 101,
      title: 'Issue 101',
      body: 'Body',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/101',
      labels: ['bug'],
      updated_at: '2026-09-02T12:00:00Z',
    }

    // When the label is removed remotely
    const deactivated = reconcileIssueWithTask(task, withoutInclusion, 20, sampleConfig)

    // Then the item is deactivated rather than deleted, and keeps its identity
    expect(deactivated.integrations?.github?.deactivated).toBe(true)
    expect(deactivated.id).toBe('task-1')

    // And when the label is added back, the same task is restored
    const withInclusion: GitHubIssuePayload = {
      ...withoutInclusion,
      labels: ['bug', 'dsh'],
      updated_at: '2026-09-02T13:00:00Z',
    }
    const restored = reconcileIssueWithTask(deactivated, withInclusion, 30, sampleConfig)
    expect(restored.integrations?.github?.deactivated).toBeUndefined()
    expect(restored.id).toBe('task-1')
  })

  it('operator imports an issue as a card carrying the full provider metadata', () => {
    // Given a GitHub issue carrying the inclusion label and some repository labels
    const issue: GitHubIssuePayload = {
      number: 42,
      node_id: 'I_node123',
      title: 'Fix issue 42',
      body: 'Detailed description of fix',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/42',
      labels: ['dsh', 'dsh:state:todo', 'component:ui'],
      updated_at: '2026-09-02T10:00:00Z',
    }

    // When it is materialized as a task
    const task = materializeTaskFromIssue(issue, 'task-uuid', 100, sampleConfig)

    // Then the card carries the stable identity and the remote metadata
    expect(task.id).toBe('task-uuid')
    expect(task.title).toBe('Fix issue 42')
    expect(task.description).toBe('Detailed description of fix')
    expect(task.prompt).toBe('Detailed description of fix')
    expect(task.status).toBe('todo')
    expect(task.integrations?.github).toEqual({
      provider: 'github',
      owner: 'deepseek-ai',
      repository: 'dsh',
      issueNumber: 42,
      issueNodeId: 'I_node123',
      issueUrl: 'https://github.com/deepseek-ai/dsh/issues/42',
      remoteTitle: 'Fix issue 42',
      remoteBody: 'Detailed description of fix',
      remoteState: 'open',
      remoteLabels: ['dsh', 'dsh:state:todo', 'component:ui'],
      lastSyncedAt: 100,
      lastRemoteUpdatedAt: Date.parse('2026-09-02T10:00:00Z'),
    })
  })

  it('operator importing an issue with many labels is not truncated by the native tag limit', () => {
    // Given an issue carrying more labels than the native 8-tag limit allows
    const manyLabels = Array.from({ length: 12 }, (_, i) => `label-${String(i + 1)}`)
    const issue: GitHubIssuePayload = {
      number: 99,
      title: 'Many labels',
      body: '',
      state: 'open',
      html_url: 'https://github.com/deepseek-ai/dsh/issues/99',
      labels: manyLabels,
      updated_at: '2026-09-02T10:00:00Z',
    }

    // When it is materialized as a task
    const task = materializeTaskFromIssue(issue, 'task-many-labels', 100, sampleConfig)

    // Then every remote label is retained as provider metadata, and none of them
    // leaked into the native tag list (which is what carries promptPrefix)
    expect(task.integrations?.github?.remoteLabels).toHaveLength(12)
    expect(task.tags).toBeUndefined()
  })

  it('operator sees malformed stored integrations dropped while a valid one is repaired', () => {
    // Given corrupted and whitespace-padded provider metadata
    // When each is normalized
    // Then unusable entries are dropped and the valid one is trimmed
    expect(normalizeIntegrations(null)).toBeUndefined()
    expect(normalizeIntegrations({})).toBeUndefined()
    expect(normalizeIntegrations({ github: { provider: 'gitlab' } })).toBeUndefined()

    const valid = normalizeIntegrations({
      github: {
        provider: 'github',
        owner: '  deepseek-ai ',
        repository: ' dsh ',
        issueNumber: 15,
        issueUrl: 'https://github.com/deepseek-ai/dsh/issues/15',
        remoteLabels: ['dsh', 'bug'],
        pullRequest: {
          number: 200,
          url: 'https://github.com/deepseek-ai/dsh/pull/200',
          state: 'open',
          draft: true,
          headBranch: 'feat/test',
        },
      },
    })

    expect(valid?.github?.owner).toBe('deepseek-ai')
    expect(valid?.github?.repository).toBe('dsh')
    expect(valid?.github?.issueNumber).toBe(15)
    expect(valid?.github?.pullRequest?.number).toBe(200)
    expect(valid?.github?.pullRequest?.draft).toBe(true)
    expect(valid?.github?.pullRequest?.headBranch).toBe('feat/test')
  })
})
