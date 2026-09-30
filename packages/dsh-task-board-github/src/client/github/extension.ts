/**
 * Browser-half installer for the GitHub provider.
 *
 * A provider's browser half registers its own contributions into the child
 * seats the board declares; it resolves the board's client capability face from
 * the shared service name and adds no HTTP surface of its own. Two switches
 * compose here:
 *
 * - the BOARD's master switch collapses the seats (the board mirror reports it,
 *   and the board's own registrations collapse with them);
 * - this EXTENSION's own volatile switch hides the seats entirely, without a
 *   restart, because the installer follows the settings form the card edits.
 *
 * The board's browser half publishes its `taskBoard` service inside its own
 * apply, and the aggregate mounts its client children without ordering those
 * applies, so the service is frequently NOT there yet when this installer runs.
 * The seats therefore live behind a cordis dependency scope (`ctx.inject`)
 * instead of a one-shot lookup: the scope mounts once the board serves the
 * service and unloads — releasing every seat — when the board withdraws it.
 * A one-shot "resolve, give up, never retry" lookup is what made the seats
 * permanently absent under a real aggregate load.
 *
 * @module dsh-task-board-github/client/github/extension
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  resolveTaskBoardClientFace,
  TASK_BOARD_CARD_DECORATION,
  TASK_BOARD_DETAIL_SECTION,
} from '../../core/contract.ts'
import { GITHUB_EXTENSION_ID } from '../../core/types.ts'
import { GitHubCardDecoration, GitHubDetailSection } from './sections.tsx'
import { acceptPublishedSummaries, clearSummary } from './summary.ts'
import { isGitHubTaskVisible } from './visibility.ts'

/** Locale namespace the seats bind to. */
const LOCALE_NS = 'task-board-github'

/** The live switch the installer follows; the settings card's form supplies it. */
export interface ExtensionEnabledSource {
  /** Whether the extension is currently enabled (absent config means enabled). */
  read(): boolean
  /** Observe switch changes; the returned disposer removes the listener. */
  subscribe(listener: () => void): () => void
}

/**
 * Install the GitHub browser half.
 * @param ctx - client context (slot registry).
 * @param source - the extension's live enabled switch.
 * @returns disposer releasing every contribution.
 */
export function installGitHubClientHalf(ctx: ClientContext, source: ExtensionEnabledSource): () => void {
  /** The dependency-scoped fiber that owns the seats, while both gates are on. */
  let injection: ReturnType<ClientContext['inject']> | undefined

  const install = (): void => {
    if (injection !== undefined) return
    // Cordis runs this callback once the board serves `taskBoard` — immediately
    // if it is already there (on the microtask the fiber load settles on), or
    // the moment it appears otherwise — and disposes the scope when the service
    // is withdrawn or replaced, which is what releases the seats again.
    injection = ctx.inject(['taskBoard'], (scope: ClientContext) => {
      scope.effect(() => installSeats(scope), 'task-board-github: provider seats')
    })
  }

  const release = (): void => {
    const current = injection
    injection = undefined
    if (current === undefined) return
    void current.dispose()
    // A hidden provider publishes no summary; keep the last one from looking
    // like live state on a settings page that is still open.
    clearSummary()
  }

  const apply = (): void => {
    if (source.read()) install()
    else release()
  }

  const unsubscribe = source.subscribe(apply)
  apply()

  return () => {
    unsubscribe()
    release()
  }
}

/**
 * Register the two seats, the visibility predicate and the mirror
 * subscription, for as long as the board's own master switch is on. The
 * board's settings seat is deliberately unused: the repository/credential
 * summary is part of this extension's own settings card.
 * @param ctx - client context.
 * @returns disposer releasing every contribution.
 */
function installSeats(ctx: ClientContext): () => void {
  const face = resolveTaskBoardClientFace(ctx)
  if (face === undefined) {
    // Unreachable while the dependency scope holds: `ctx.inject(['taskBoard'])`
    // only runs this once the service is served. It stays as a guard against a
    // service that answers the name without carrying the client contract, and
    // it is not a dead end — cordis re-runs this effect when the implementation
    // behind the name changes.
    console.error('[dsh-task-board-github] the taskBoard service does not answer the client contract')
    return () => {}
  }
  const slots = ctx.slots as {
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const seats: Array<() => void> = []
  let registered = false

  const ensure = (): void => {
    if (registered) return
    registered = true
    try {
      seats.push(slots.register({ name: TASK_BOARD_DETAIL_SECTION, id: GITHUB_EXTENSION_ID, locale: LOCALE_NS }, GitHubDetailSection as never))
      seats.push(slots.register({ name: TASK_BOARD_CARD_DECORATION, id: GITHUB_EXTENSION_ID }, GitHubCardDecoration as never))
    } catch (error) {
      console.error('[dsh-task-board-github] seat registration failed', error)
    }
  }
  const release = (): void => {
    registered = false
    for (const dispose of seats.splice(0)) {
      try { dispose() } catch { /* best-effort */ }
    }
  }

  const disposeVisibility = face.registerVisibility(isGitHubTaskVisible)
  const unsubscribe = face.subscribe(mirror => {
    if (mirror.enabled) ensure()
    else release()
    acceptPublishedSummaries(mirror.extensions)
  })
  // Establish immediately when the board is already running; the mirror
  // subscription covers the enable transition.
  const current = face.snapshot()
  if (current.enabled) ensure()
  acceptPublishedSummaries(current.extensions)

  return () => {
    unsubscribe()
    disposeVisibility()
    release()
  }
}
