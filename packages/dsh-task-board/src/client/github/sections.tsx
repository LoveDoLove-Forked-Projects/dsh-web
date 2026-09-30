/**
 * GitHub provider surfaces rendered into the board's child seats.
 *
 * These components are the provider's browser half: they receive the board's
 * seat owner props ({ task, dispatch } / { dispatch }) and talk back only
 * through `dispatch`, never through a board internal or an HTTP surface of
 * their own.
 *
 * @module dsh-task-board/client/github/sections
 */
import { useEffect, useState } from 'react'
import { readTaskGitHubMetadata, type GitHubTaskMetadata } from '../../core/github/types.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import type {
  TaskBoardDetailSectionProps,
  TaskBoardExtensionDispatch,
  TaskBoardSettingsSectionProps,
} from '../../core/extension.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { formatHostTimestamp } from '../board/TaskCard.tsx'
import css from '../board.module.css'

/** Extension id these surfaces dispatch under. */
const EXTENSION_ID = 'github'

/** The summary the provider publishes (mirrors its host snapshotSummary). */
interface GitHubSummary {
  enabled?: boolean
  hasCredential?: boolean
  repositories?: Array<{
    owner: string
    repository: string
    inclusionLabel: string
    prCreationEnabled: boolean
    hasCredential: boolean
  }>
}

/** Report a dispatch failure the way the action channel phrased it. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function CreatePrModal({ dispatch, metadata, task, onClose }: {
  dispatch: TaskBoardExtensionDispatch
  metadata: GitHubTaskMetadata
  task: TaskRecord
  onClose: () => void
}) {
  const [headBranch, setHeadBranch] = useState(`issue-${metadata.issueNumber}`)
  const [baseBranch, setBaseBranch] = useState('main')
  const [draft, setDraft] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const handleCreate = async (): Promise<void> => {
    if (headBranch.trim() === '') return
    setLoading(true)
    setError(undefined)
    try {
      await dispatch({
        extensionId: EXTENSION_ID,
        action: 'create-pr',
        taskId: task.id,
        payload: {
          headBranch: headBranch.trim(),
          ...(baseBranch.trim() === '' ? {} : { baseBranch: baseBranch.trim() }),
          draft,
        },
      })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className={css.modal} role="dialog" aria-label={t('detail.github.createPrTitle')}>
        <h3 className={css.modalTitle}>{t('detail.github.createPrTitle')}</h3>
        <div className={css.modalBody}>
          {error !== undefined && <p className={css.formError}>{error}</p>}
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('detail.github.headBranch')}</span>
            <input
              type="text"
              className={css.input}
              value={headBranch}
              placeholder={t('detail.github.headBranchPlaceholder')}
              onChange={event => setHeadBranch(event.target.value)}
              disabled={loading}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('detail.github.baseBranch')}</span>
            <input
              type="text"
              className={css.input}
              value={baseBranch}
              onChange={event => setBaseBranch(event.target.value)}
              disabled={loading}
            />
          </label>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={draft}
              onChange={event => setDraft(event.target.checked)}
              disabled={loading}
            />
            <span>{t('detail.github.prDraft')}</span>
          </label>
        </div>
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose} disabled={loading}>
            {t('new.cancel')}
          </button>
          <button type="button" className={css.primaryButton} onClick={() => { void handleCreate() }} disabled={loading || headBranch.trim() === ''}>
            {loading ? t('detail.github.refreshing') : t('detail.github.createPr')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function LinkPrModal({ dispatch, task, onClose }: {
  dispatch: TaskBoardExtensionDispatch
  task: TaskRecord
  onClose: () => void
}) {
  const [prNumber, setPrNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const handleLink = async (): Promise<void> => {
    const number = Number(prNumber)
    if (!Number.isInteger(number) || number <= 0) return
    setLoading(true)
    setError(undefined)
    try {
      await dispatch({
        extensionId: EXTENSION_ID,
        action: 'link-pr',
        taskId: task.id,
        payload: { pullRequestNumber: number },
      })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className={css.modal} role="dialog" aria-label={t('detail.github.linkPrTitle')}>
        <h3 className={css.modalTitle}>{t('detail.github.linkPrTitle')}</h3>
        <div className={css.modalBody}>
          {error !== undefined && <p className={css.formError}>{error}</p>}
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('detail.github.prNumberInput')}</span>
            <input
              type="number"
              className={css.input}
              value={prNumber}
              min="1"
              onChange={event => setPrNumber(event.target.value)}
              disabled={loading}
            />
          </label>
        </div>
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose} disabled={loading}>
            {t('new.cancel')}
          </button>
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => { void handleLink() }}
            disabled={loading || !Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0}
          >
            {loading ? t('detail.github.refreshing') : t('detail.github.linkPr')}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** The task-detail seat: the issue, its labels and its pull request. */
export function GitHubDetailSection({ task, dispatch }: TaskBoardDetailSectionProps) {
  const metadata = readTaskGitHubMetadata(task)
  const [refreshing, setRefreshing] = useState(false)
  const [showCreatePr, setShowCreatePr] = useState(false)
  const [showLinkPr, setShowLinkPr] = useState(false)
  const [error, setError] = useState<string | undefined>()

  if (metadata === undefined) return null

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(undefined)
    try {
      await dispatch({ extensionId: EXTENSION_ID, action: 'refresh', taskId: task.id })
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className={css.detailSection} data-dsh-part="github-integration">
      <h4>{t('detail.github.title')}</h4>
      {metadata.deactivated === true && (
        <p className={css.formError}>{t('detail.github.deactivated')}</p>
      )}
      <div className={css.detailText} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <a
          href={metadata.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={css.linkButton}
          data-dsh-part="github-link"
          title={metadata.issueUrl}
        >
          {metadata.owner}/{metadata.repository} #{metadata.issueNumber} ↗
        </a>
        <span className={css.statusBadge} data-status={metadata.remoteState === 'closed' ? 'done' : 'todo'}>
          {t(`detail.github.state.${metadata.remoteState ?? 'open'}` as TaskBoardKey)}
        </span>
      </div>

      {metadata.remoteLabels.length > 0 && (
        <div className={css.cardTags} style={{ marginTop: '6px' }}>
          {metadata.remoteLabels.map(label => (
            <span key={label} className={css.cardTag} data-dsh-part="github-label" title={label}>
              {label}
            </span>
          ))}
        </div>
      )}

      {metadata.pullRequest !== undefined && (
        <div className={css.detailText} data-dsh-part="github-pr" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span>{t('detail.github.pr')}:</span>
          <a href={metadata.pullRequest.url} target="_blank" rel="noopener noreferrer" className={css.linkButton} title={metadata.pullRequest.url}>
            {t('detail.github.prNumber', { number: String(metadata.pullRequest.number) })} ↗
          </a>
          <span className={css.statusBadge} data-status={metadata.pullRequest.state === 'merged' ? 'done' : metadata.pullRequest.state === 'closed' ? 'failed' : 'running'}>
            {t(`detail.github.prState.${metadata.pullRequest.state}` as TaskBoardKey)}
          </span>
          {metadata.pullRequest.draft && <span className={css.cardTag}>{t('detail.github.prDraft')}</span>}
          {metadata.pullRequest.headBranch !== undefined && (
            <span className={css.detailMeta}>
              ({metadata.pullRequest.headBranch} → {metadata.pullRequest.baseBranch ?? 'main'})
            </span>
          )}
        </div>
      )}

      {metadata.lastSyncedAt !== undefined && (
        <p className={css.detailMeta} style={{ marginTop: '6px' }}>
          {t('detail.github.syncedAt', { time: formatHostTimestamp(metadata.lastSyncedAt) })}
        </p>
      )}

      {metadata.lastSyncError !== undefined && metadata.lastSyncError !== '' && (
        <p className={css.formError}>{t('detail.github.syncError', { error: metadata.lastSyncError })}</p>
      )}
      {error !== undefined && <p className={css.formError}>{error}</p>}

      <div className={css.moveRow} style={{ marginTop: '8px' }}>
        <button type="button" className={css.ghostButton} disabled={refreshing} onClick={() => { void handleRefresh() }}>
          {refreshing ? t('detail.github.refreshing') : t('detail.github.refresh')}
        </button>
        {metadata.pullRequest === undefined && (
          <>
            <button type="button" className={css.ghostButton} disabled={refreshing} onClick={() => setShowCreatePr(true)}>
              {t('detail.github.createPr')}
            </button>
            <button type="button" className={css.ghostButton} disabled={refreshing} onClick={() => setShowLinkPr(true)}>
              {t('detail.github.linkPr')}
            </button>
          </>
        )}
      </div>

      {showCreatePr && (
        <CreatePrModal dispatch={dispatch} metadata={metadata} task={task} onClose={() => setShowCreatePr(false)} />
      )}
      {showLinkPr && (
        <LinkPrModal dispatch={dispatch} task={task} onClose={() => setShowLinkPr(false)} />
      )}
    </section>
  )
}

/** The card-decoration seat: a compact issue reference on linked cards. */
export function GitHubCardDecoration({ task }: { task: TaskRecord }) {
  const metadata = readTaskGitHubMetadata(task)
  if (metadata === undefined) return null
  return (
    <span className={css.cardSchedule} data-dsh-part="github-badge" title={`${metadata.owner}/${metadata.repository}#${metadata.issueNumber}`}>
      #{metadata.issueNumber}
    </span>
  )
}

/** The settings seat: configured repositories and credential state. */
export function GitHubSettingsSection(_props: TaskBoardSettingsSectionProps) {
  const [summary, setSummary] = useState<GitHubSummary | undefined>()
  // The published summary rides the board's existing state endpoint (SSE
  // carries no extension payload); the extension adds no HTTP surface of its own.
  useEffect(() => {
    let live = true
    void fetch('api/task-board/state')
      .then(response => response.ok ? response.json() : undefined)
      .then((data: { extensions?: Record<string, unknown> } | undefined) => {
        const published = data?.extensions?.[EXTENSION_ID]
        if (published !== undefined && live) setSummary(published as GitHubSummary)
      })
      .catch(() => {})
    return () => { live = false }
  }, [])

  return (
    <div data-dsh-part="github-settings" style={{ marginTop: '16px', borderTop: '1px solid var(--dsw-alias-border-subtle, #333)', paddingTop: '12px' }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', fontWeight: 600 }}>{t('settings.github.title')}</h4>
      {summary?.repositories !== undefined && summary.repositories.length > 0 ? (
        <div>
          <p style={{ margin: '4px 0', fontSize: '12px' }}>
            {t('settings.github.configuredRepos', { count: String(summary.repositories.length) })}:
          </p>
          <ul style={{ margin: '4px 0 8px 16px', padding: 0, fontSize: '12px' }}>
            {summary.repositories.map(repository => (
              <li key={`${repository.owner}/${repository.repository}`}>
                <strong>{repository.owner}/{repository.repository}</strong> (label: <code>{repository.inclusionLabel}</code>
                {repository.prCreationEnabled ? ', auto PR' : ''})
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={{ margin: '4px 0 8px 0', fontSize: '12px', opacity: 0.8 }}>
          {t('settings.github.noRepos')}
        </p>
      )}
      <p style={{ margin: '4px 0', fontSize: '12px', opacity: 0.8 }}>
        {summary?.hasCredential ? t('settings.github.credentialOk') : t('settings.github.credentialMissing')}
      </p>
    </div>
  )
}
