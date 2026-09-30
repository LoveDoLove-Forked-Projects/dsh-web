/**
 * Task card: the board's column item. Clicking opens the task detail — it
 * never executes anything directly (detail holds the Run button).
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card onClick is built with a stable task reference
 * by the board, so the memo boundary is effective.
 */
import { memo } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import { executionLabel, hasOpenExecution, tagTone } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { useTaskBoardSeats } from '../seats.tsx'
import { verificationRunningKey } from './status-key.ts'
import css from '../board.module.css'

/**
 * Built formatters, keyed by time zone ('' = the browser's own). Constructing
 * an Intl.DateTimeFormat is orders of magnitude more expensive than formatting
 * with one, and the board renders dozens of timestamps per SSE frame; the
 * cached formatter keeps that cost off the render path.
 */
const HOST_TIMESTAMP_FORMATS = new Map<string, Intl.DateTimeFormat>()

function hostTimestampFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  const cached = HOST_TIMESTAMP_FORMATS.get(key)
  if (cached !== undefined) return cached
  const format = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...(timeZone === undefined ? {} : { timeZone }),
  })
  HOST_TIMESTAMP_FORMATS.set(key, format)
  return format
}

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return hostTimestampFormat(timeZone).format(new Date(ms))
  } catch {
    // An unsupported time-zone id throws on construction: never cache it, and
    // fall back to the ISO instant for this call.
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function TaskCardInner({
  task,
  pending,
  timeZone,
  onClick,
  subtaskCount = 0,
  isSubtask = false,
  subtasksDone = 0,
  subtasksRunning = 0,
  subtasksFailed = 0,
}: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onClick: () => void
  /** Direct subtasks of this card, shown as a badge (0 hides it). */
  subtaskCount?: number
  /** Whether this card is itself a subtask. */
  isSubtask?: boolean
  /** Direct subtasks already settled as done, for the roll-up badge. */
  subtasksDone?: number
  /** Direct subtasks currently running, for the roll-up badge. */
  subtasksRunning?: number
  /** Direct subtasks that failed, for the roll-up badge. */
  subtasksFailed?: number
}) {
  const { cardDecoration } = useTaskBoardSeats()
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length
  const archived = task.archivedAt !== undefined
  // The lock is an open execution, not the column: a card parked in 'running'
  // by hand stays draggable, and an executing card never is.
  const busy = hasOpenExecution(task)
  const isDraggable = !archived && !busy && !pending
  // Forced acceptance owns the running label.
  const runningKey = verificationRunningKey(latest?.verification)

  return (
    <button
      type="button"
      className={css.card}
      data-status={archived ? 'archived' : task.status}
      data-dsh-part="card"
      data-pending={pending || undefined}
      draggable={isDraggable}
      onDragStart={isDraggable ? (event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
      } : undefined}
      onClick={onClick}
      title={task.description !== '' ? task.description : task.title}
    >
      <span className={css.cardTitle}>{task.title}</span>
      {task.tags !== undefined && task.tags.length > 0 && (
        <span className={css.cardTags}>
          {task.tags.map(tag => (
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
        </span>
      )}
      {task.description !== '' && <span className={css.cardExcerpt}>{task.description}</span>}
      <span className={css.cardMeta}>
        {isSubtask && (
          <span className={css.cardSubtask} data-dsh-part="subtask-badge">{t('card.subtask')}</span>
        )}
        {subtaskCount > 0 && (
          // A board that hides subtask cards still has to report them: the badge
          // rolls up the direct children and takes the tone of the worst state,
          // so a hidden failing tree cannot look green.
          <span
            className={css.cardSubtask}
            data-dsh-part="subtask-count"
            data-tone={subtasksFailed > 0 ? 'failed' : subtasksRunning > 0 ? 'running' : subtasksDone === subtaskCount ? 'done' : undefined}
            title={t('card.subtasksBreakdown', {
              total: String(subtaskCount),
              done: String(subtasksDone),
              running: String(subtasksRunning),
              failed: String(subtasksFailed),
            })}
          >
            {t('card.subtasks', { count: String(subtaskCount) })}
            {subtasksFailed > 0 ? ' · ' + t('card.subtasksFailed', { count: String(subtasksFailed) }) : ''}
            {subtasksFailed === 0 && subtasksRunning > 0 ? ' · ' + t('card.subtasksRunning', { count: String(subtasksRunning) }) : ''}
          </span>
        )}
        <span className={css.cardTime}>{t('board.updated')} {formatTime(task.updatedAt)}</span>
        {task.freeze !== undefined && (
          <span className={css.cardSchedule} title={task.freeze.goal}>{t('card.frozen')}</span>
        )}
        {!archived && task.schedule?.enabled === true && (
          <span
            className={css.cardSchedule}
            title={task.schedule.nextRunAt !== undefined
              ? `${t('card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
              : t('card.scheduled')}
          >
            {t('card.scheduled')}
          </span>
        )}
        {latest !== undefined && (
          <span className={css.cardRun} data-result={archived ? undefined : latest.result}>
            {runs} {t('board.runs')}
          </span>
        )}
        {latest?.sessionId !== undefined && (
          <span className={css.cardSession} title={latest.sessionId}>⌁</span>
        )}
        {!archived && (busy || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
      </span>
      {cardDecoration({ task })}
      {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
      {!archived && latest !== undefined && executionLabel(latest) === 'running' && (
        <span className={css.cardRunningLabel}>
          {runningKey !== undefined
            ? t(runningKey)
            : latest.ownResult === undefined ? t('detail.result.running') : t('detail.subtasks.waiting')}…
        </span>
      )}
    </button>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)
