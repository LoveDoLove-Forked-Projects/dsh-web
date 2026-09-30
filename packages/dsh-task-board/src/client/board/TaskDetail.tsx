/**
 * Task detail: the full view of one task — content, prompt, execution
 * history — and the only place execution can be triggered. Also offers
 * delete (with confirmation), manual status moves, and a jump to the
 * execution's session transcript.
 */
import { useEffect, useState } from 'react'
import type { BoardController, ControllerSnapshot } from '../../core/controller.ts'
import { isValidCron } from '../../core/schedule.ts'
import { MANUAL_STATUSES, TASK_PERMISSIONS, canMoveTask, hasOpenExecution, tagTone, type ExecutionRecord, type TaskPermission, type TaskRecord } from '../../core/tasks.ts'
import { canEditTaskContent } from '../../core/use-cases/task-update.ts'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import { DEFAULT_SUBTASK_DEPTH, directSubtasks, taskDepth } from '../../core/subtask.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import { nextRunLabel, zoneChoices } from '../schedule-zone.ts'
import css from '../board.module.css'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { EditTaskModal, EditTagsModal } from './EditTaskModal.tsx'
import { LinkSubtaskModal } from './LinkSubtaskModal.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import { inheritPresetLabel, presetLabel } from './preset-label.ts'
import { formatHostTimestamp, formatTime } from './TaskCard.tsx'
import { STATUS_KEY } from './status-key.ts'
import { VerificationReport } from './VerificationReport.tsx'

/** Execution outcome → locale key. */
const RESULT_KEY: Record<NonNullable<ExecutionRecord['result']>, TaskBoardKey> = {
  succeeded: 'detail.result.succeeded',
  failed: 'detail.result.failed',
  cancelled: 'detail.result.cancelled',
}

/** One execution-history row. */
function ExecutionRow({ execution, timeZone, onOpen }: { execution: ExecutionRecord; timeZone?: string; onOpen: (sessionId: string) => void }) {
  const result = execution.result
  return (
    <li className={css.executionRow} data-result={result}>
      <span className={css.executionBadge} data-result={result}>
        {result === undefined ? t('detail.result.running') : t(RESULT_KEY[result])}
      </span>
      <span className={css.executionTimes}>
        {t('detail.executionStarted')} {formatTime(execution.startedAt, timeZone)}
        {execution.endedAt !== undefined && ` · ${t('detail.executionEnded')} ${formatTime(execution.endedAt, timeZone)}`}
      </span>
      {execution.initiatedBy !== undefined && (
        <span className={css.executionTimes} title={execution.initiatedBy}>
          {t('detail.execution.initiator', { session: execution.initiatedBy })}
        </span>
      )}
      {execution.verification !== undefined && <VerificationReport verification={execution.verification} />}
      {execution.sessionId !== undefined && (
        <button
          type="button"
          className={css.linkButton}
          onClick={() => { onOpen(execution.sessionId as string) }}
          title={execution.sessionId}
        >
          {t('detail.viewSession')} ⌁
        </button>
      )}
      {execution.error !== undefined && execution.error !== '' && (
        <span className={css.executionError}>{execution.error}</span>
      )}
    </li>
  )
}

/** The execution-target editor: workspace / mode / permission pickers. */
function ExecutionSettingsSection({ controller, task, pending, executionOptions, teamRunAvailable }: {
  controller: BoardController
  task: TaskRecord
  pending: boolean
  /** Picker option sets, owned by the detail overlay's snapshot. */
  executionOptions: ControllerSnapshot['executionOptions']
  /** Whether this deployment serves the Agent Teams service. */
  teamRunAvailable: boolean
}) {
  const options = executionOptions
  const workspaceId = task.workspaceId ?? ''
  const mode = task.mode ?? ''
  const permission = task.permission ?? ''
  const model = task.model ?? ''
  // A pinned target may disappear from the runtime (workspace deleted,
  // preset removed); keep it selectable as a stale row instead of silently
  // dropping it, so the user sees exactly what the task will ask for.
  const workspaceKnown = workspaceId === '' || options.workspaces.some(item => item.workspaceId === workspaceId)
  const modeKnown = mode === '' || options.presets.some(item => item.id === mode)
  const modelKnown = model === '' || (options.models ?? []).some(item => item.id === model)
  return (
    <section className={css.detailSection}>
      <h4>{t('detail.executionSettings')}</h4>
      <p className={css.detailText}>{t('exec.hint')}</p>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.workspace')}</span>
        <select
          className={css.select}
          value={workspaceId}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { workspaceId: event.target.value }) }}
        >
          <option value="">{t('exec.workspace.recent')}</option>
          {!workspaceKnown && <option value={workspaceId}>{workspaceId}{t('exec.mode.removed')}</option>}
          {options.workspaces.map(workspace => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.agentPreset')}</span>
        <select
          className={css.select}
          value={mode}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { mode: event.target.value }) }}
        >
          <option value="">{inheritPresetLabel(options.presets)}</option>
          {!modeKnown && <option value={mode}>{mode}{t('exec.mode.removed')}</option>}
          {options.presets.map(preset => (
            <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
              {presetLabel(preset)}
              {preset.isDefault ? t('exec.mode.defaultSuffix') : ''}
              {preset.broken !== undefined ? t('exec.mode.brokenSuffix') : ''}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.permission')}</span>
        <select
          className={css.select}
          value={permission}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { permission: event.target.value === '' ? undefined : event.target.value as TaskPermission }) }}
        >
          <option value="">{t('exec.permission.default')}</option>
          {TASK_PERMISSIONS.map(id => (
            <option key={id} value={id}>{t(`exec.permission.${id}` as TaskBoardKey)}</option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.model')}</span>
        <select
          className={css.select}
          value={model}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { model: event.target.value === '' ? undefined : event.target.value }) }}
        >
          <option value="">{t('exec.model.default')}</option>
          {!modelKnown && <option value={model}>{model}{t('exec.model.unknown')}</option>}
          {options.models?.map(item => (
            <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
          ))}
        </select>
      </label>
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={task.reuseSession === true}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { reuseSession: event.target.checked }) }}
        />
        <span>{t('exec.reuseSession')}</span>
      </label>
      <p className={css.detailText}>{t('exec.reuseSessionHint')}</p>
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={task.goalRun !== false}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { goalRun: event.target.checked }) }}
        />
        <span>{t('exec.goalRun')}</span>
      </label>
      <p className={css.detailText}>{t('exec.goalRunHint')}</p>
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={task.teamRun === true}
          disabled={pending || !teamRunAvailable}
          onChange={event => { controller.updateTask(task.id, { teamRun: event.target.checked }) }}
        />
        <span>{t('exec.teamRun')}</span>
      </label>
      <p className={css.detailText}>{teamRunAvailable ? t('exec.teamRunHint') : t('exec.teamRunUnavailable')}</p>
    </section>
  )
}

/** The scheduled-runs editor: enable toggle, cron input + presets, zone, next-run info. */
function ScheduleSection({ controller, task, pending }: { controller: BoardController; task: TaskRecord; pending: boolean }) {
  const schedule = task.schedule
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * *')
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false)
  const [nextRunAt, setNextRunAt] = useState<number | undefined>(schedule?.nextRunAt)
  const [lastTriggeredAt, setLastTriggeredAt] = useState<number | undefined>(schedule?.lastTriggeredAt)
  const [error, setError] = useState<string | undefined>(undefined)
  const hostTimeZone = controller.getSnapshot().host?.scheduler.timeZone
  // The rule's own zone; '' means "follow the Host zone" (no stored zone).
  const [zone, setZone] = useState<string>(schedule?.timeZone ?? '')
  // One clock reading per render pass, so the absolute and relative halves of
  // the label always describe the same instant.
  const now = Date.now()

  // Keep the editor in sync when the task record changes underneath (the
  // schedule rolls forward as runs trigger).
  useEffect(() => {
    setCron(schedule?.cron ?? '0 9 * * *')
    setEnabled(schedule?.enabled ?? false)
    setNextRunAt(schedule?.nextRunAt)
    setLastTriggeredAt(schedule?.lastTriggeredAt)
    setZone(schedule?.timeZone ?? '')
    setError(undefined)
  }, [task.id, schedule?.enabled, schedule?.cron, schedule?.timeZone, schedule?.nextRunAt, schedule?.lastTriggeredAt])

  /** Validate + persist the current cron text (Enter or blur). */
  const saveCron = (value: string): void => {
    const trimmed = value.trim()
    setCron(trimmed)
    if (trimmed === '' || !isValidCron(trimmed)) {
      setError(t('detail.schedule.invalid'))
      return
    }
    setError(undefined)
    controller.setSchedule(task.id, { cron: trimmed })
  }

  /**
   * Change the rule's zone. `''` clears the stored zone, which is how a user
   * returns a rule to following the Host zone.
   */
  const changeZone = (value: string): void => {
    setZone(value)
    setError(undefined)
    controller.setSchedule(task.id, { timeZone: value === '' ? null : value })
  }

  /** Arm/disarm the schedule (arming first persists the edited cron). */
  const toggleEnabled = (next: boolean): void => {
    const trimmed = cron.trim()
    if (next && (trimmed === '' || !isValidCron(trimmed))) {
      setError(t('detail.schedule.invalid'))
      return
    }
    setError(undefined)
    const submitted = controller.setSchedule(task.id, {
      enabled: next,
      ...(next && trimmed !== schedule?.cron ? { cron: trimmed } : {}),
    })
    if (submitted && !controller.isHostBacked()) setEnabled(next)
  }

  const applyPreset = (preset: string): void => {
    if (preset === '') return
    setCron(preset)
    setError(undefined)
    controller.setSchedule(task.id, { cron: preset })
  }

  // The zone the rule's wall clock is actually read in: its own when set,
  // otherwise the Host zone. The preview must use the same one the Host will.
  const effectiveZone = zone === '' ? hostTimeZone : zone
  const nextLabel = !enabled || nextRunAt === undefined
    ? t('detail.schedule.notScheduled')
    : nextRunAt <= now
      ? t('detail.schedule.dueSoon')
      : nextRunLabel(nextRunAt, effectiveZone, formatHostTimestamp, now)
  const lastLabel = lastTriggeredAt === undefined ? '—' : formatHostTimestamp(lastTriggeredAt, effectiveZone)
  // The rule's own stored zone rides the list even when this runtime's
  // inventory does not carry it, so opening the editor cannot rewrite it.
  const zones = zoneChoices(hostTimeZone, schedule?.timeZone)

  return (
    <section className={css.detailSection}>
      <h4>{t('detail.schedule')}</h4>
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={event => { toggleEnabled(event.target.checked) }}
        />
        <span>{t('detail.schedule.enable')}</span>
      </label>
      <div className={css.scheduleRow}>
        <input
          className={`${css.input} ${css.scheduleInput}${error !== undefined ? ` ${css.scheduleInputInvalid}` : ''}`}
          value={cron}
          disabled={pending}
          placeholder="0 9 * * *"
          spellCheck={false}
          aria-label={t('detail.schedule.cron')}
          onChange={event => { setCron(event.target.value); setError(undefined) }}
          onBlur={() => { saveCron(cron) }}
          onKeyDown={event => { if (event.key === 'Enter') saveCron(cron) }}
        />
        <select
          className={css.schedulePreset}
          value=""
          disabled={pending}
          aria-label={t('detail.schedule.presets')}
          onChange={event => { applyPreset(event.target.value) }}
        >
          <option value="">{t('detail.schedule.presets')}…</option>
          {SCHEDULE_PRESETS.map(preset => (
            <option key={preset.cron} value={preset.cron}>{t(preset.label)}</option>
          ))}
        </select>
      </div>
      {/* A list is used instead of a free-text field so only zones the Host can
          also resolve are offered; the Host zone entry clears the stored value. */}
      <label className={css.scheduleZone}>
        <span>{t('detail.schedule.timeZone')}</span>
        <select
          className={css.schedulePreset}
          value={zone}
          disabled={pending}
          aria-label={t('detail.schedule.timeZone')}
          title={t('detail.schedule.timeZoneHint')}
          onChange={event => { changeZone(event.target.value) }}
        >
          {zones.map(choice => (
            <option key={choice.id === '' ? '__host' : choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </select>
      </label>
      {error !== undefined && <p className={css.formError}>{error}</p>}
      <p className={css.scheduleMeta}>
        {t('detail.schedule.nextRun')} {nextLabel}
        {' · '}{t('detail.schedule.lastTriggered')} {lastLabel}
      </p>
    </section>
  )
}

/**
 * The subtask block: the parent link, the direct subtasks with their status,
 * and the actions that grow or prune the tree. Every gate here mirrors the
 * Host lineage gate for affordance only; the Host re-checks the action.
 */
function SubtaskSection({ controller, task, pending, archived, snapshot }: {
  controller: BoardController
  task: TaskRecord
  pending: boolean
  archived: boolean
  /** Detail-overlay snapshot; the overlay already re-renders on every notify. */
  snapshot: ControllerSnapshot
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const tasks = snapshot.tasks
  const parent = task.parentId === undefined ? undefined : tasks.find(candidate => candidate.id === task.parentId)
  const children = directSubtasks(tasks, task.id)
  const limit = snapshot.host?.maxSubtaskDepth ?? DEFAULT_SUBTASK_DEPTH
  // A new subtask is a leaf, so it fits whenever one more level is allowed.
  const canAddChild = taskDepth(tasks, task.id) + 1 <= limit
  const editable = !archived && !pending
  return (
    <section className={css.detailSection} data-dsh-part="subtasks">
      <h4>{t('detail.subtasks')}</h4>
      {parent !== undefined && (
        <p className={css.detailText}>
          {t('detail.parent')}:{' '}
          <button
            type="button"
            className={css.linkButton}
            title={t('detail.parent.open')}
            onClick={() => { controller.openTask(parent.id) }}
          >
            {parent.title}
          </button>
        </p>
      )}
      {children.length === 0
        ? <p className={css.detailText}>{t('detail.subtasks.empty')}</p>
        : (
          <ul className={css.subtaskList}>
            {children.map(child => (
              <li key={child.id} className={css.subtaskRow}>
                <button
                  type="button"
                  className={css.linkButton}
                  onClick={() => { controller.openTask(child.id) }}
                >
                  {child.title}
                </button>
                <span className={css.statusBadge} data-status={child.status}>{t(STATUS_KEY[child.status])}</span>
                {!archived && (
                  <button
                    type="button"
                    className={css.linkButton}
                    disabled={pending || hasOpenExecution(child)}
                    title={hasOpenExecution(child) ? t('detail.subtasks.runningLock') : undefined}
                    onClick={() => { void controller.setParent(child.id, null) }}
                  >
                    {t('detail.subtasks.detach')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      {children.length > 0 && (
        <p className={css.detailText}>{t('detail.subtasks.runHint', { count: String(children.length) })}</p>
      )}
      {!archived && (canAddChild
        ? (controller.isHostBacked()
          ? (
            <div className={css.subtaskAddRow}>
              <button type="button" className={css.ghostButton} disabled={!editable} onClick={() => { setShowAdd(true) }}>
                + {t('detail.subtasks.add')}
              </button>
              <button type="button" className={css.ghostButton} disabled={!editable} onClick={() => { setShowLink(true) }}>
                {t('detail.subtasks.link')}
              </button>
            </div>
            )
          : <p className={css.detailMeta}>{t('detail.subtasks.hostOnly')}</p>)
        : <p className={css.detailMeta}>{t('detail.subtasks.depthLimit', { depth: String(limit) })}</p>)}
      {showAdd && (
        <NewTaskModal controller={controller} parentTask={task} onClose={() => { setShowAdd(false) }} />
      )}
      {showLink && (
        <LinkSubtaskModal controller={controller} parent={task} onClose={() => { setShowLink(false) }} />
      )}
    </section>
  )
}


function CreatePrModal({ controller, task, onClose }: { controller: BoardController; task: TaskRecord; onClose: () => void }) {
  const gh = task.integrations?.github
  const [headBranch, setHeadBranch] = useState(`issue-${gh?.issueNumber ?? ''}`)
  const [baseBranch, setBaseBranch] = useState('main')
  const [draft, setDraft] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const handleCreate = async () => {
    if (headBranch.trim() === '') return
    setLoading(true)
    setError(undefined)
    try {
      const ok = await controller.createGitHubPr(task.id, {
        headBranch: headBranch.trim(),
        baseBranch: baseBranch.trim() || undefined,
        draft,
      })
      if (!ok) {
        setError(controller.getSnapshot().transportError ?? 'Failed to create PR')
      } else {
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
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
              onChange={e => setHeadBranch(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('detail.github.baseBranch')}</span>
            <input
              type="text"
              className={css.input}
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={draft}
              onChange={e => setDraft(e.target.checked)}
              disabled={loading}
            />
            <span>{t('detail.github.prDraft')}</span>
          </label>
        </div>
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose} disabled={loading}>
            {t('new.cancel')}
          </button>
          <button type="button" className={css.primaryButton} onClick={handleCreate} disabled={loading || headBranch.trim() === ''}>
            {loading ? t('detail.github.refreshing') : t('detail.github.createPr')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function LinkPrModal({ controller, task, onClose }: { controller: BoardController; task: TaskRecord; onClose: () => void }) {
  const [prNumber, setPrNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const handleLink = async () => {
    const num = Number(prNumber)
    if (!Number.isInteger(num) || num <= 0) return
    setLoading(true)
    setError(undefined)
    try {
      const ok = await controller.linkGitHubPr(task.id, num)
      if (!ok) {
        setError(controller.getSnapshot().transportError ?? 'Failed to link PR')
      } else {
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
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
              onChange={e => setPrNumber(e.target.value)}
              disabled={loading}
            />
          </label>
        </div>
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose} disabled={loading}>
            {t('new.cancel')}
          </button>
          <button type="button" className={css.primaryButton} onClick={handleLink} disabled={loading || !Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0}>
            {loading ? t('detail.github.refreshing') : t('detail.github.linkPr')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function GitHubSection({ controller, task, pending, timeZone }: {
  controller: BoardController
  task: TaskRecord
  pending: boolean
  timeZone?: string
}) {
  const gh = task.integrations?.github
  if (gh === undefined) return null

  const [refreshing, setRefreshing] = useState(false)
  const [showCreatePr, setShowCreatePr] = useState(false)
  const [showLinkPr, setShowLinkPr] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await controller.refreshGitHub(task.id)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className={css.detailSection} data-dsh-part="github-integration">
      <h4>{t('detail.github.title')}</h4>
      {gh.deactivated === true && (
        <p className={css.formError}>{t('detail.github.deactivated')}</p>
      )}
      <div className={css.detailText} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <a
          href={gh.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={css.linkButton}
          data-dsh-part="github-link"
          title={gh.issueUrl}
        >
          {gh.owner}/{gh.repository} #{gh.issueNumber} ↗
        </a>
        <span className={css.statusBadge} data-status={gh.remoteState === 'closed' ? 'done' : 'todo'}>
          {t(`detail.github.state.${gh.remoteState ?? 'open'}` as TaskBoardKey)}
        </span>
      </div>

      {gh.remoteLabels.length > 0 && (
        <div className={css.cardTags} style={{ marginTop: '6px' }}>
          {gh.remoteLabels.map(label => (
            <span
              key={label}
              className={css.cardTag}
              data-dsh-part="github-label"
              title={label}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {gh.pullRequest !== undefined && (
        <div className={css.detailText} data-dsh-part="github-pr" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span>{t('detail.github.pr')}:</span>
          <a
            href={gh.pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className={css.linkButton}
            title={gh.pullRequest.url}
          >
            {t('detail.github.prNumber', { number: String(gh.pullRequest.number) })} ↗
          </a>
          <span className={css.statusBadge} data-status={gh.pullRequest.state === 'merged' ? 'done' : gh.pullRequest.state === 'closed' ? 'failed' : 'running'}>
            {t(`detail.github.prState.${gh.pullRequest.state}` as TaskBoardKey)}
          </span>
          {gh.pullRequest.draft && (
            <span className={css.cardTag}>{t('detail.github.prDraft')}</span>
          )}
          {gh.pullRequest.headBranch && (
            <span className={css.detailMeta}>
              ({gh.pullRequest.headBranch} → {gh.pullRequest.baseBranch ?? 'main'})
            </span>
          )}
        </div>
      )}

      {gh.lastSyncedAt !== undefined && (
        <p className={css.detailMeta} style={{ marginTop: '6px' }}>
          {t('detail.github.syncedAt', { time: formatHostTimestamp(gh.lastSyncedAt, timeZone) })}
        </p>
      )}

      {gh.lastSyncError !== undefined && gh.lastSyncError !== '' && (
        <p className={css.formError}>{t('detail.github.syncError', { error: gh.lastSyncError })}</p>
      )}

      <div className={css.moveRow} style={{ marginTop: '8px' }}>
        <button
          type="button"
          className={css.ghostButton}
          disabled={pending || refreshing}
          onClick={handleRefresh}
        >
          {refreshing ? t('detail.github.refreshing') : t('detail.github.refresh')}
        </button>
        {gh.pullRequest === undefined && (
          <>
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending || refreshing}
              onClick={() => setShowCreatePr(true)}
            >
              {t('detail.github.createPr')}
            </button>
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending || refreshing}
              onClick={() => setShowLinkPr(true)}
            >
              {t('detail.github.linkPr')}
            </button>
          </>
        )}
      </div>

      {showCreatePr && (
        <CreatePrModal
          controller={controller}
          task={task}
          onClose={() => setShowCreatePr(false)}
        />
      )}
      {showLinkPr && (
        <LinkPrModal
          controller={controller}
          task={task}
          onClose={() => setShowLinkPr(false)}
        />
      )}
    </section>
  )
}

/** Task detail overlay. */
export function TaskDetail({ controller, task }: { controller: BoardController; task: TaskRecord }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showEditTags, setShowEditTags] = useState(false)
  const [showDuplicate, setShowDuplicate] = useState(false)

  // Keep the overlay in sync if the task record changes underneath.
  const [latest, setLatest] = useState(task)
  useEffect(() => { setLatest(task) }, [task])
  // A re-used overlay instance must not carry an edit session across tasks.
  useEffect(() => {
    setShowEdit(false)
    setShowEditTags(false)
    setShowDuplicate(false)
  }, [task.id])
  const current = latest
  const snapshot = controller.getSnapshot()
  // Busy means the runner is executing this card, which is an execution the
  // detail view can see; the column alone never locks a card.
  const busy = hasOpenExecution(current)
  const archived = current.archivedAt !== undefined
  const pending = snapshot.pendingTaskIds.includes(current.id)
  const transportError = snapshot.transportError
  const timeZone = snapshot.host?.scheduler.timeZone
  const permissionPending = requiresPermissionConfirmation(current, snapshot.host?.sessionDefaultPermission)
  const subtaskChildren = directSubtasks(snapshot.tasks, current.id)

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) controller.closeTask() }}>
      <div className={css.detail} role="dialog" aria-label={t('detail.title')}>
        <header className={css.detailHeader}>
          <h2 className={css.detailTitle}>{current.title}</h2>
          <span className={css.statusBadge} data-status={archived ? 'archived' : current.status}>
            {archived ? t('board.archive') : t(STATUS_KEY[current.status])}
          </span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('detail.close')}
            onClick={() => { controller.closeTask() }}
          >
            ×
          </button>
        </header>

        <div className={css.detailBody}>
          {transportError !== undefined && (
            <div className={css.formError}>
              {t('board.hostError', { error: transportError })}{' '}
              <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
                {t('board.retryHost')}
              </button>
            </div>
          )}
          <section className={css.detailSection}>
            <h4>{t('detail.description')}</h4>
            <p className={css.detailText}>{current.description !== '' ? current.description : '—'}</p>
          </section>

          <SubtaskSection controller={controller} task={current} pending={pending} archived={archived} snapshot={snapshot} />

          {current.tags !== undefined && current.tags.length > 0 && (
            <section className={css.detailSection} data-dsh-part="tags">
              <h4>{t('new.tags')}</h4>
              <div className={css.cardTags}>
                {current.tags.map(tag => (
                  <span
                    key={tag.name}
                    className={css.cardTag}
                    data-tag-tone={tagTone(tag.name)}
                    data-dsh-part="tag-badge"
                    data-tag-hint={tag.promptPrefix === undefined ? undefined : tag.promptPrefix}
                    title={tag.promptPrefix === undefined ? tag.name : tag.promptPrefix}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {current.freeze !== undefined && (
            <section className={css.detailSection} data-dsh-part="freeze">
              <h4>{t('detail.freeze')}</h4>
              {current.freeze.redacted === true && <p className={css.formError}>{t('detail.freeze.redacted')}</p>}
              <p className={css.detailText}><strong>{t('detail.freeze.goal')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.goal}</pre>
              <p className={css.detailText}><strong>{t('detail.freeze.progress')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.progress}</pre>
              <p className={css.detailText}><strong>{t('detail.freeze.next')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.next}</pre>
              <p className={css.detailMeta}>{t('detail.freeze.frozenAt', { time: formatHostTimestamp(current.freeze.frozenAt, timeZone) })}</p>
              {current.freeze.frozenBy !== undefined && (
                <p className={css.detailMeta}>{t('detail.freeze.frozenBy', { session: current.freeze.frozenBy })}</p>
              )}
            </section>
          )}

          {current.handover !== undefined && (
            <section className={css.detailSection} data-dsh-part="handover">
              <h4>{t('detail.handover')}</h4>
              <p className={css.detailText}>
                {t('new.workspace')}: {current.handover.workspaceId ?? t('exec.workspace.recent')}
                {' · '}{t('new.agentPreset')}: {current.handover.mode ?? t('exec.mode.inherit')}
                {' · '}{t('new.permission')}: {current.handover.permission === undefined ? t('exec.permission.default') : t(`exec.permission.${current.handover.permission}` as TaskBoardKey)}
              </p>
              <p className={css.detailText}><strong>{t('detail.handover.references')}</strong></p>
              <ul className={css.executionList}>
                {current.handover.references.map((reference, index) => (
                  // References are free text from the freeze block, so the same
                  // string can appear twice; the index keeps the key unique (#1492).
                  <li key={`${reference}-${index}`} className={css.executionRow}><code>{reference}</code></li>
                ))}
              </ul>
              <p className={css.detailMeta}>{t('detail.handover.bundledAt', { time: formatHostTimestamp(current.handover.bundledAt, timeZone) })}</p>
            </section>
          )}

          {permissionPending && (
            <section className={css.detailSection} data-dsh-part="permission-gate">
              <p className={css.formError}>{t('detail.permissionPending', { permission: t(`exec.permission.${current.handover?.permission ?? current.permission}` as TaskBoardKey) })}</p>
              <button type="button" className={css.primaryButton} disabled={pending} onClick={() => { void controller.confirmPermission(current.id) }}>
                {t('detail.permissionConfirm')}
              </button>
            </section>
          )}
          {current.permissionConfirmedAt !== undefined && (
            <p className={css.detailMeta}>{t('detail.permissionConfirmed', { time: formatHostTimestamp(current.permissionConfirmedAt, timeZone) })}</p>
          )}

          <GitHubSection controller={controller} task={current} pending={pending} timeZone={timeZone} />

          <section className={css.detailSection}>
            <h4>{t('detail.prompt')}</h4>
            <pre className={css.promptBlock}>{current.prompt !== '' ? current.prompt : current.title}</pre>
          </section>

          {!archived && (
            <>
              <ExecutionSettingsSection
                controller={controller}
                task={current}
                pending={pending}
                executionOptions={snapshot.executionOptions}
                teamRunAvailable={snapshot.host?.teamRunAvailable === true}
              />
              <ScheduleSection controller={controller} task={current} pending={pending} />
            </>
          )}

          <section className={css.detailSection}>
            <h4>{t('detail.execution')}</h4>
            {current.executions.length === 0 ? (
              <p className={css.detailText}>{t('detail.noExecution')}</p>
            ) : (
              <ul className={css.executionList}>
                {[...current.executions].reverse().map(execution => (
                  <ExecutionRow
                    key={execution.id}
                    execution={execution}
                    timeZone={timeZone}
                    onOpen={sessionId => { controller.openSession(sessionId) }}
                  />
                ))}
              </ul>
            )}
          </section>

          {!archived && (
            <section className={css.detailSection}>
              <h4>{t('board.status')}</h4>
              <div className={css.moveRow}>
                {MANUAL_STATUSES.map(status => (
                  <button
                    key={status}
                    type="button"
                    className={css.ghostButton}
                    disabled={pending || !canMoveTask(current, status)}
                    onClick={() => { controller.moveTask(current.id, status) }}
                  >
                    {t(`status.move.${status}` as TaskBoardKey)}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className={css.detailFooter}>
          {!archived && pending && <span className={css.detailMeta}>{t('board.pending')}…</span>}
          {!archived && canEditTaskContent(current) && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending}
              onClick={() => { setShowEdit(true) }}
            >
              {t('detail.edit')}
            </button>
          )}
          {!archived && !canEditTaskContent(current) && !busy && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending}
              onClick={() => { setShowEditTags(true) }}
            >
              {t('detail.editTags')}
            </button>
          )}
          {!archived && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending}
              onClick={() => { setShowDuplicate(true) }}
              title={canEditTaskContent(current) ? t('detail.duplicate') : t('detail.duplicateAndEdit')}
            >
              {canEditTaskContent(current) ? t('detail.duplicate') : t('detail.duplicateAndEdit')}
            </button>
          )}
          {!archived && (
            <button
              type="button"
              className={css.primaryButton}
              disabled={busy || pending}
              title={subtaskChildren.length > 0
                ? t('detail.subtasks.runHint', { count: String(subtaskChildren.length) })
                : undefined}
              onClick={() => {
                void controller.rerunTask(current.id).then(() => {
                  if (controller.getSnapshot().transportError === undefined) controller.closeTask()
                })
              }}
            >
              {current.executions.length === 0 ? t('detail.run') : t('detail.rerun')}
            </button>
          )}
          {archived ? (
            <button
              type="button"
              className={css.primaryButton}
              disabled={pending}
              onClick={() => {
                controller.restoreTask(current.id)
              }}
            >
              {t('detail.restore')}
            </button>
          ) : (
            (current.status === 'done' || current.status === 'failed') && (
              <button
                type="button"
                className={css.ghostButton}
                disabled={pending}
                onClick={() => {
                  controller.archiveTask(current.id)
                }}
              >
                {t('detail.archive')}
              </button>
            )
          )}
          <button
            type="button"
            className={css.dangerButton}
            disabled={pending}
            onClick={() => { setConfirmDelete(true) }}
          >
            {t('detail.delete')}
          </button>
          <span className={css.detailMeta}>
            {t('board.created')} {formatTime(current.createdAt, timeZone)}
            {archived && ` · ${t('detail.archivedAt', { time: formatTime(current.archivedAt!, timeZone) })}`}
          </span>
        </footer>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('delete.title')}
          message={t('delete.confirm', { name: current.title })}
          confirmLabel={t('delete.ok')}
          danger
          onCancel={() => { setConfirmDelete(false) }}
          onConfirm={() => {
            setConfirmDelete(false)
            controller.deleteTask(current.id)
          }}
        />
      )}

      {showEdit && !archived && canEditTaskContent(current) && (
        <EditTaskModal controller={controller} task={current} onClose={() => { setShowEdit(false) }} />
      )}

      {showEditTags && !archived && !busy && (
        <EditTagsModal controller={controller} task={current} onClose={() => { setShowEditTags(false) }} />
      )}

      {showDuplicate && !archived && (
        <NewTaskModal
          controller={controller}
          initialTask={current}
          onClose={() => { setShowDuplicate(false) }}
          onDuplicateSuccess={async (sourceId) => {
            await controller.archiveTask(sourceId)
            controller.closeTask()
          }}
        />
      )}
    </div>
  )
}
