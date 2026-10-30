/**
 * Bridge to the official remote namespaces the built-in plugin group reads
 * through, and to the event that says the host rewrote the profile.
 *
 * - `remote.pluginInventory` — the Loader snapshot (entries and, when a roster is
 *   composed, each agent preset's rows).
 * - `remote.pluginManager` — the very manager the official Plugins page drives:
 *   per-row writability, the installed bundle roster, and enable/disable.
 * - `plugin-manager/changed` — forwarded on the `remote` root after a write, so a
 *   second page (or the official page's own switch) re-reads instead of showing
 *   a stale toggle.
 *
 * Every face is OPTIONAL: `ctx.inject` runs the effect when the namespace is
 * published and disposes it when it goes away, which clears the snapshot. An
 * absent face leaves the group's read-only "unavailable" state, never a write.
 *
 * CONTRACT OBSERVATION: cross-package value imports are forbidden and this
 * package does not depend on the api-remotes assembly types, so the members
 * called here are re-declared. Their shapes are the official manager's own
 * schemas, not ones this package invented.
 * @module @linxin666/dsh-client-ui-plugin-manager/client
 */

import type { Context } from '@deepseek-ai/cordis'

/** The inventory namespace's one method. */
export interface InventoryFace {
  /** Read the Loader, and every composed preset's rows, on each call. */
  list(): Promise<unknown>
}

/** The manager namespace's methods this package calls. */
export interface ManagerFace {
  /** Every Loader entry with its `patchId` or the reason it cannot be written. */
  listPlugins(): Promise<unknown>
  /** Every installed bundle, with the rows its patch inserts. */
  listBundles(): Promise<unknown>
  /** Enable or disable one Loader entry through the official manager. */
  setPluginEnabled(entryId: string, enabled: boolean): Promise<unknown>
}

/** The `remote` root's forwarded-event subscription. */
export interface RemoteEventFace {
  $on?(event: string, listener: (payload: unknown) => void): () => void
}

/** What the group reads, sampled per render; `version` moves on every change. */
export interface RemoteSnapshot {
  readonly version: number
  readonly inventory: InventoryFace | null
  readonly manager: ManagerFace | null
}

let snapshot: RemoteSnapshot = { version: 0, inventory: null, manager: null }
const listeners = new Set<() => void>()

/**
 * Merge one face change into the snapshot and notify subscribers. `version`
 * always moves, so a consumer that keys its read on it re-reads after a swap.
 * @param patch - the faces to replace; an omitted face keeps its current value.
 */
function patchRemote(patch: { inventory?: InventoryFace | null; manager?: ManagerFace | null }): void {
  snapshot = {
    version: snapshot.version + 1,
    inventory: patch.inventory === undefined ? snapshot.inventory : patch.inventory,
    manager: patch.manager === undefined ? snapshot.manager : patch.manager,
  }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A consumer's listener failure is its own; keep notifying the rest.
    }
  }
}

/** The current snapshot (stable reference between changes). */
export function getRemoteSnapshot(): RemoteSnapshot {
  return snapshot
}

/**
 * Subscribe to snapshot changes.
 * @param listener - called after every face swap or forwarded change event.
 * @returns the unsubscribe function.
 */
export function subscribeRemote(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Bridge the official faces into the snapshot. Uses `ctx.inject` (not the
 * plugin's module-level inject array) so each face stays optional.
 * @param ctx - the client context the plugin runs in.
 */
export function bridgeRemoteNamespaces(ctx: Context): void {
  ctx.inject(['remote.pluginInventory'], inner => {
    inner.effect(() => {
      patchRemote({ inventory: (inner.get('remote.pluginInventory') as InventoryFace | undefined) ?? null })
      return () => { patchRemote({ inventory: null }) }
    }, 'plugin-manager: built-in group inventory face')
  })
  ctx.inject(['remote.pluginManager'], inner => {
    inner.effect(() => {
      patchRemote({ manager: (inner.get('remote.pluginManager') as ManagerFace | undefined) ?? null })
      return () => { patchRemote({ manager: null }) }
    }, 'plugin-manager: built-in group manager face')
  })
  ctx.inject(['remote'], inner => {
    inner.effect(() => {
      const remote = inner.get('remote') as RemoteEventFace | undefined
      let off: (() => void) | undefined
      try {
        off = remote?.$on?.('plugin-manager/changed', () => { patchRemote({}) })
      } catch {
        // Forwarded events need a Connection carrying interactions=answer. A
        // carrier without them keeps the group's own read-after-write path, and
        // this subscription stays empty instead of breaking the group.
      }
      return () => { off?.() }
    }, 'plugin-manager: built-in group change feed')
  })
}
