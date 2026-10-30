/**
 * Mounting the built-in plugin group at the bottom of the official Plugins page.
 *
 * The page declares no seat at the list's end: its extension points are
 * `plugins.detail.*` (per page), `plugins.bundle.config` / `plugins.row.config` /
 * `plugins.item` (configuration entries) and `plugins.bundle.activation`. Its
 * list view is `<section data-plugin-panel> <header/> <div class="…_installedPanel">
 * <section data-plugin-group="basic|extensions|bundles"/> … </div> … </section>`,
 * and the class names are CSS-module hashes, so the seat is found through the
 * page's own data attributes plus DOM position: the section after the installed
 * panel, which is a flex column of 32px gaps whose direct children are exactly
 * the width of the groups above.
 *
 * The container is a plain element carrying its own React root, so it can never
 * disturb the page's reconciliation, and it re-seats itself through the
 * page-wide body-mutation hub: a re-render that moves or drops the panel is
 * followed on the next frame, a panel switch that unmounts the list detaches
 * the container until the list returns, and the detail / "all plugins" views
 * (which render no bundles group) leave it off the page entirely.
 * @module @linxin666/dsh-client-ui-plugin-manager/client
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { subscribeBodyInvalidations } from './body-mutations.ts'
import { BuiltinPlugins, type BuiltinPluginsProps } from './BuiltinPlugins.tsx'
import css from './plugin-manager.module.css'

/** Stable attribute identifying the injected container (mount idempotency). */
export const BUILTIN_GROUP_MOUNT_SELECTOR = '[data-dsh-plugin-manager-builtin]'

/** The mount's inputs. */
export interface BuiltinGroupMountOptions {
  /** Build the group's props; called on mount and on every locale change. */
  props: () => BuiltinPluginsProps
  /** Locale change subscription (ctx.locale.subscribe); re-renders the group. */
  subscribe?: (listener: () => void) => () => void
}

/**
 * The official page's installed panel, when the list view is mounted.
 * @returns the element the group belongs after, or undefined off the list view.
 */
export function builtinGroupSeat(): HTMLElement | undefined {
  const page = document.querySelector('[data-plugin-panel]')
  const panel = page?.querySelector('[data-plugin-group="bundles"]')?.parentElement
  return panel instanceof HTMLElement ? panel : undefined
}

/**
 * Mount the built-in plugin group after the installed panel.
 * @param options - props factory and the optional locale subscription.
 * @returns disposer removing the container, its observers and its React root.
 */
export function mountBuiltinPluginGroup(options: BuiltinGroupMountOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  // DOM-level idempotency: whatever path mounted a group before this call (a
  // duplicated apply, an HMR re-injection), never mount a second one.
  if (document.querySelector(BUILTIN_GROUP_MOUNT_SELECTOR) !== null) return () => {}

  const container = document.createElement('div')
  container.setAttribute('data-dsh-plugin-manager-builtin', '')
  container.className = css.builtinMount
  const root: Root = createRoot(container)
  const render = (): void => {
    root.render(createElement(BuiltinPlugins, options.props()))
  }
  render()

  /**
   * Keep the container immediately after the installed panel; detach while the
   * list is away. React owns the page's children and appends its own blocks
   * (a failure notice among them) after that panel, so the anchor is the
   * panel's next sibling rather than the panel's last child.
   */
  const place = (): void => {
    const seat = builtinGroupSeat()
    if (seat === undefined) {
      container.remove()
      return
    }
    if (container.previousElementSibling !== seat) seat.after(container)
  }
  place()

  const unsubscribeBody = subscribeBodyInvalidations(place)
  const unsubscribeLocale = options.subscribe === undefined ? ((): void => {}) : options.subscribe(render)

  return () => {
    unsubscribeBody()
    unsubscribeLocale()
    root.unmount()
    container.remove()
  }
}
