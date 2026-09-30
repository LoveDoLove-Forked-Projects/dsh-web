/**
 * Browser-half installer for the GitHub provider.
 *
 * A provider's browser half registers its own contributions into the child
 * seats the board declares; it resolves the board's client capability face
 * from the shared service name and adds no HTTP surface of its own. The seats
 * collapse with the board's own registrations, so the installer re-establishes
 * them whenever the board mirror reports the board is enabled again.
 *
 * @module dsh-task-board/client/github/extension
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  TASK_BOARD_CARD_DECORATION,
  TASK_BOARD_DETAIL_SECTION,
  TASK_BOARD_SETTINGS_SECTION,
  type TaskBoardClientFace,
} from '../../core/extension.ts'
import { GitHubCardDecoration, GitHubDetailSection, GitHubSettingsSection } from './sections.tsx'
import { isGitHubTaskVisible } from './visibility.ts'

/** Extension id; matches the host half's registration. */
export const GITHUB_EXTENSION_ID = 'github'

/** Locale namespace the seats bind to (the provider's copy lives in the board namespace). */
const LOCALE_NS = 'task-board'

/**
 * Install the GitHub browser half.
 * @param ctx - client context (slot registry).
 * @param face - the board's client capability face.
 * @returns disposer releasing every contribution.
 */
export function installGitHubClientExtension(ctx: ClientContext, face: TaskBoardClientFace): () => void {
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
      seats.push(slots.register({ name: TASK_BOARD_SETTINGS_SECTION, id: GITHUB_EXTENSION_ID, locale: LOCALE_NS }, GitHubSettingsSection as never))
      seats.push(slots.register({ name: TASK_BOARD_CARD_DECORATION, id: GITHUB_EXTENSION_ID }, GitHubCardDecoration as never))
    } catch (error) {
      console.error('[dsh-task-board] GitHub seats registration failed', error)
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
  })
  // Establish immediately when the board is already running; the mirror
  // subscription covers the enable transition.
  if (face.snapshot().enabled) ensure()

  return () => {
    unsubscribe()
    disposeVisibility()
    release()
  }
}
