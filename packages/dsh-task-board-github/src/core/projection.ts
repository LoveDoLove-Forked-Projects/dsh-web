/**
 * Pure projection and reconciliation logic for GitHub issue integration.
 *
 * Implements:
 * - Controlled label write-back (only DSH-managed labels modified).
 * - Projection into existing kanban columns without a secondary state machine.
 * - Stable identity reconciliation and deactivation handling.
 *
 * Content immutability is NOT decided here any more: reconciliation always
 * proposes the remote title/body, and the board's own content gate refuses the
 * patch when the card has started executing. The provider therefore has no
 * second opinion about which cards are frozen.
 *
 * @module dsh-task-board-github/core/projection
 */

import type { TaskRecord, TaskStatus } from './task-record.ts'
import {
  readTaskGitHubMetadata,
  type GitHubIssuePayload,
  type ResolvedGitHubRepoConfig,
} from './types.ts'

/** Check if a GitHub label is owned and managed by the DSH task board integration. */
export function isDshManagedLabel(labelName: string, config: ResolvedGitHubRepoConfig): boolean {
  if (labelName === config.prPhaseLabel) return true
  const stateLabels = Object.values(config.stateLabels)
  if (stateLabels.includes(labelName)) return true
  return config.managedLabelPrefix !== '' && labelName.startsWith(config.managedLabelPrefix)
}

/**
 * Compute the exact label changes required to project a task's lifecycle onto GitHub.
 *
 * Guaranteed contract:
 * - ONLY DSH-managed labels are added or removed.
 * - User/repository labels (e.g. 'bug', 'security', 'priority:high', and the inclusion label)
 *   are left completely untouched.
 */
export function computeLabelWriteBack(
  currentLabels: readonly string[],
  targetStatus: TaskStatus,
  prActive: boolean,
  config: ResolvedGitHubRepoConfig,
): { labelsToAdd: string[]; labelsToRemove: string[] } {
  const currentSet = new Set(currentLabels)
  const allStateLabels = new Set(Object.values(config.stateLabels))
  const targetStateLabel = config.stateLabels[targetStatus]

  const labelsToRemove: string[] = []
  const labelsToAdd: string[] = []

  // Remove any conflicting state label currently on the issue
  for (const label of currentLabels) {
    if (allStateLabels.has(label) && label !== targetStateLabel) {
      labelsToRemove.push(label)
    }
  }

  // Add the target state label if not already present
  if (!currentSet.has(targetStateLabel)) {
    labelsToAdd.push(targetStateLabel)
  }

  // PR phase label handling
  if (prActive) {
    if (!currentSet.has(config.prPhaseLabel)) {
      labelsToAdd.push(config.prPhaseLabel)
    }
  } else if (currentSet.has(config.prPhaseLabel)) {
    labelsToRemove.push(config.prPhaseLabel)
  }

  return { labelsToAdd, labelsToRemove }
}

/**
 * Compute the final set of labels after applying a write-back diff.
 * Preserves the exact ordering of untouched labels and appends new ones.
 */
export function applyLabelWriteBack(
  currentLabels: readonly string[],
  targetStatus: TaskStatus,
  prActive: boolean,
  config: ResolvedGitHubRepoConfig,
): string[] {
  const { labelsToAdd, labelsToRemove } = computeLabelWriteBack(currentLabels, targetStatus, prActive, config)
  const removeSet = new Set(labelsToRemove)
  const result = currentLabels.filter(label => !removeSet.has(label))
  for (const label of labelsToAdd) {
    if (!result.includes(label)) {
      result.push(label)
    }
  }
  return result
}

/**
 * Project remote GitHub labels and state into an initial local task status.
 *
 * Local state machine is authoritative; running remains Host-local.
 * Remote closed issues project to 'done'.
 */
export function resolveStatusFromLabels(
  labels: readonly string[],
  remoteState: 'open' | 'closed' | undefined,
  config: ResolvedGitHubRepoConfig,
): TaskStatus {
  if (remoteState === 'closed') return 'done'
  const set = new Set(labels)
  if (set.has(config.stateLabels.failed)) return 'failed'
  if (set.has(config.stateLabels.done)) return 'done'
  if (set.has(config.stateLabels.backlog)) return 'backlog'
  return 'todo'
}

/**
 * Extract label name strings from a GitHub API issue payload.
 */
export function extractLabelNames(issue: GitHubIssuePayload): string[] {
  return issue.labels.map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}

/**
 * Extract the logins an issue is assigned to, lowercased. The REST listing
 * returns user objects; a hand-built payload may carry plain strings.
 */
export function issueAssignees(issue: GitHubIssuePayload): string[] {
  const assignees = issue.assignees ?? []
  if (!Array.isArray(assignees)) return []
  return assignees
    .map(entry => (typeof entry === 'string' ? entry : entry?.login ?? ''))
    .filter(login => login !== '')
    .map(login => login.toLowerCase())
}

/**
 * Whether one issue belongs on the board.
 *
 * Two channels feed the board and either one is enough: the issue carries the
 * repository's inclusion label, or it is assigned to the login the repository
 * configured. The host substitutes the authenticated login for
 * {@link ME_ASSIGNEE} before syncing, so this predicate only ever compares
 * concrete logins.
 * @param issue - the remote issue.
 * @param config - the repository configuration (its assignee already resolved).
 * @returns true when the issue is included.
 */
export function isIssueIncluded(issue: GitHubIssuePayload, config: ResolvedGitHubRepoConfig): boolean {
  if (extractLabelNames(issue).includes(config.inclusionLabel)) return true
  const assignee = config.assignee
  return assignee !== undefined && assignee !== '' && issueAssignees(issue).includes(assignee)
}

/**
 * Reconcile a remote GitHub issue with an existing local task record.
 *
 * - Updates remote metadata (remoteTitle, remoteBody, remoteLabels, remoteState, sync stamps).
 * - If the issue stops being included (its inclusion label went away and it is
 *   no longer assigned to the configured login), deactivates the item without
 *   deleting it or its executions.
 * - If it becomes included again, restores the item through the same identity.
 * - Proposes the remote title/description/prompt; the board's content gate keeps
 *   the recorded content of a card that has already executed.
 */
export function reconcileIssueWithTask(
  existing: TaskRecord,
  issue: GitHubIssuePayload,
  now: number,
  config: ResolvedGitHubRepoConfig,
): TaskRecord {
  const remoteLabels = extractLabelNames(issue)
  const hasInclusion = isIssueIncluded(issue, config)

  const remoteTitle = issue.title.trim()
  const remoteBody = issue.body != null ? issue.body.trim() : ''

  const remoteUpdatedAt = Date.parse(issue.updated_at)

  return {
    ...existing,
    title: remoteTitle,
    description: remoteBody,
    prompt: remoteBody !== '' ? remoteBody : remoteTitle,
    updatedAt: now,
    integrations: {
      ...existing.integrations,
      github: {
        provider: 'github',
        owner: config.owner,
        repository: config.repository,
        issueNumber: issue.number,
        issueNodeId: issue.node_id,
        issueUrl: issue.html_url,
        remoteTitle,
        remoteBody,
        remoteState: issue.state === 'closed' ? 'closed' : 'open',
        remoteLabels,
        lastSyncedAt: now,
        lastRemoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : undefined,
        lastSyncError: undefined,
        pullRequest: readTaskGitHubMetadata(existing)?.pullRequest,
        deactivated: hasInclusion ? undefined : true,
      },
    },
  }
}

/**
 * Materialize a brand-new TaskRecord from an incoming GitHub issue carrying the inclusion label.
 */
export function materializeTaskFromIssue(
  issue: GitHubIssuePayload,
  id: string,
  now: number,
  config: ResolvedGitHubRepoConfig,
): TaskRecord {
  const remoteLabels = extractLabelNames(issue)
  const remoteTitle = issue.title.trim()
  const remoteBody = issue.body != null ? issue.body.trim() : ''
  const prompt = remoteBody !== '' ? remoteBody : remoteTitle
  const status = resolveStatusFromLabels(remoteLabels, issue.state, config)
  const remoteUpdatedAt = Date.parse(issue.updated_at)

  return {
    id,
    title: remoteTitle,
    description: remoteBody,
    prompt,
    status,
    createdAt: now,
    updatedAt: now,
    executions: [],
    integrations: {
      github: {
        provider: 'github',
        owner: config.owner,
        repository: config.repository,
        issueNumber: issue.number,
        issueNodeId: issue.node_id,
        issueUrl: issue.html_url,
        remoteTitle,
        remoteBody,
        remoteState: issue.state === 'closed' ? 'closed' : 'open',
        remoteLabels,
        lastSyncedAt: now,
        lastRemoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : undefined,
      },
    },
  }
}
