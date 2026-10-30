/**
 * The built-in plugin group's pure logic: which global Loader entries no
 * installed bundle contributes, how each one may be written, and the two answer
 * shapes the official remote namespaces return.
 *
 * "Built-in" is a subtraction, not a roster of ours: the inventory's Loader
 * entries minus every entry an installed bundle's patch inserts. That covers the
 * rows a profile patch inserts itself — the Computer Use pair among them — and
 * the rows the host ships globally, without this package keeping a list that
 * would drift. The modules the official manager protects are refused by the
 * manager itself and reported per row as `readOnlyReason`, so no second
 * whitelist lives here.
 * @module @linxin666/dsh-client-ui-plugin-manager/client
 */

/** Literal text or translations indexed by language id, as package metadata carries it. */
export type DisplayText = string | { readonly en: string; readonly [locale: string]: string }

/** Display metadata the inventory attaches to a Loader entry. */
export interface EntryMeta {
  readonly title?: DisplayText
  readonly description?: DisplayText
  readonly icon?: string
  readonly error?: string
}

/** A Loader entry's fiber phase, or null when the entry has no live root. */
export type FiberPhase = null | 'failed' | 'pending' | 'active' | 'loading' | 'unloading'

/** One Loader entry as `pluginInventory.list()` reports it. */
export interface LoaderEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly meta?: EntryMeta
  readonly enabled: boolean
  readonly fiberPhase: FiberPhase
}

/** One composition row of an agent preset. */
export interface AgentPresetRow {
  readonly entryId: string | null
  readonly moduleName: string
  readonly meta?: EntryMeta
  readonly enabled: boolean | 'conditional'
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  readonly fiberPhase: FiberPhase
}

/** One composed agent preset. */
export interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  readonly rows: readonly AgentPresetRow[]
}

/** The `pluginInventory.list()` snapshot this group consumes. */
export interface PluginInventory {
  readonly managementAvailable?: boolean
  readonly entries: readonly LoaderEntry[]
  readonly agentPresets?: readonly AgentPreset[]
}

/** The slice of `pluginManager.listBundles()` this group subtracts. */
export interface BundleFacts {
  /** The installed bundle's package name; the row's owner reads as this. */
  readonly name?: string
  /**
   * Whether the profile actually declares this bundle. The roster also reports
   * bundles that are only available, and their declared rows are no mounted
   * Loader entries — counting them would take a live row out of the default scope
   * over a package that is not even installed, so `false` is skipped. Absent
   * keeps the bundle in play, which is how the manager always answers.
   */
  readonly installed?: boolean
  readonly rows?: readonly { readonly entryId?: string }[]
}

/** The slice of `pluginManager.listPlugins()` that decides a row's writability. */
export interface PluginFacts {
  readonly entryId: string
  readonly readOnlyReason?: 'management-required' | 'unaddressable'
}

/** Why a row's switch is locked, or that the manager will take a write. */
export type WriteState = 'writable' | 'management-required' | 'unaddressable' | 'unknown'

/** One row of the built-in group, in whichever scope it is shown. */
export interface BuiltinRow {
  readonly entryId: string
  readonly moduleName: string
  readonly meta?: EntryMeta
  readonly enabled: boolean
  readonly write: WriteState
  /**
   * The installed bundle whose patch inserts this entry, by package name. Absent
   * on a row no bundle contributes — the rows the group lists by default.
   */
  readonly ownedBy?: string
}

/** The group's two scopes, the ownership behind them, and the roster state. */
export interface BuiltinSelection {
  /** The default scope: the entries no installed bundle contributes. */
  readonly rows: readonly BuiltinRow[]
  /**
   * Every Loader entry in Loader order, with `ownedBy` on the ones a bundle
   * contributes. Same row shape as {@link BuiltinSelection.rows}, so the two
   * scopes render through one path.
   */
  readonly allRows: readonly BuiltinRow[]
  /** Loader entry id to the package name of the bundle that inserts it. */
  readonly owners: ReadonlyMap<string, string>
  /**
   * `confirmed` when every installed bundle was read and its rows subtracted;
   * `unconfirmed` when that read failed and every entry is listed instead.
   */
  readonly bundles: 'confirmed' | 'unconfirmed'
}

/**
 * Select the built-in group's two scopes in one pass: every Loader entry, the
 * ones no installed bundle contributes, and which bundle contributes the rest.
 *
 * The default scope is the subtraction the group shipped with; the wider scope is
 * the same rows plus the ones a bundle's patch inserts, each named after that
 * bundle — the reason a reader meets them again on the bundle's own page.
 * @param inventory - the Loader snapshot.
 * @param bundles - every installed bundle, or undefined when `listBundles()`
 *   failed; both scopes then list every entry and the group says so.
 * @param plugins - the manager's plugin rows, or undefined when that read
 *   failed; an unread row is reported as `unknown` rather than guessed writable.
 * @returns both scopes, the ownership map behind them, and the roster state.
 */
export function selectBuiltinEntries(
  inventory: PluginInventory,
  bundles: readonly BundleFacts[] | undefined,
  plugins: readonly PluginFacts[] | undefined,
): BuiltinSelection {
  const owners = new Map<string, string>()
  for (const bundle of bundles ?? []) {
    if (bundle.installed === false) continue
    for (const row of bundle.rows ?? []) {
      // First writer wins: a row two patches touch still names the bundle that
      // contributes it, and a bundle without a readable name keeps the id out of
      // the default scope either way.
      if (row.entryId !== undefined && !owners.has(row.entryId)) owners.set(row.entryId, bundle.name ?? '')
    }
  }
  const writability = new Map<string, WriteState>()
  for (const plugin of plugins ?? []) {
    writability.set(plugin.entryId, plugin.readOnlyReason ?? 'writable')
  }
  const allRows = inventory.entries.map((entry): BuiltinRow => {
    const shared = {
      entryId: entry.entryId,
      moduleName: entry.moduleName,
      meta: entry.meta,
      enabled: entry.enabled,
      write: writability.get(entry.entryId) ?? 'unknown',
    }
    const ownedBy = owners.get(entry.entryId)
    return ownedBy === undefined ? shared : { ...shared, ownedBy }
  })
  return {
    rows: allRows.filter(row => row.ownedBy === undefined),
    allRows,
    owners,
    bundles: bundles === undefined ? 'unconfirmed' : 'confirmed',
  }
}

/** One official remote answer: the gateway's envelope, or a bare value. */
export type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code?: string }

/**
 * Read one `remote.<namespace>` answer.
 *
 * The API gateway wraps every namespace result as `{ ok, value | error }`, and a
 * carrier that hands the bare value back must not be mistaken for a failure —
 * so an object is treated as an envelope only when its `ok` really is a boolean,
 * and anything else passes through as the value itself.
 * @param raw - the resolved answer, exactly as the namespace returned it.
 * @returns the unwrapped value, or the envelope's error code.
 */
export function readRemoteAnswer<T>(raw: unknown): RemoteAnswer<T> {
  if (typeof raw === 'object' && raw !== null && typeof (raw as { ok?: unknown }).ok === 'boolean') {
    const envelope = raw as { ok: boolean; value?: T; error?: { code?: string } }
    if (envelope.ok) return { ok: true, value: envelope.value as T }
    return { ok: false, code: envelope.error?.code }
  }
  return { ok: true, value: raw as T }
}

/** The applications one write can end in. */
export type ChangeApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'

/**
 * What a write achieved: the application the host settled on, or the code it
 * failed with. `overridden` is a resolved write a higher profile layer wins
 * over — the official page reports it as its own notice rather than a failure,
 * because the manager did accept the call.
 */
export type ChangeOutcome =
  | {
    readonly ok: true
    readonly application: 'applied' | 'overridden' | 'restart-required'
    /** Why `restart-required`, as the host named it. */
    readonly restartReason?: string
  }
  | { readonly ok: false; readonly code: string }

/** The result fields of one `setPluginEnabled` answer. */
interface ChangeResultFields {
  readonly application?: ChangeApplication
  readonly restartReason?: string
  readonly error?: { readonly code?: string }
}

/**
 * Read one `setPluginEnabled` answer.
 *
 * The official manager folds a refusal into the resolved result
 * (`application: 'failed'` with an `error.code`) instead of rejecting, so a
 * resolved promise is not a success. Both answer shapes are accepted because
 * the gateway's envelope and the bare `ChangeResult` are the same call seen
 * through two carriers.
 * @param raw - the resolved answer.
 * @returns the outcome the switch should show.
 */
export function readChangeResult(raw: unknown): ChangeOutcome {
  const answer = readRemoteAnswer<ChangeResultFields>(raw)
  if (!answer.ok) return { ok: false, code: answer.code ?? 'operation-error' }
  const result = answer.value
  const application = result?.application
  if (application === undefined) return { ok: false, code: 'operation-error' }
  if (application === 'failed' || application === 'cancelled') {
    return { ok: false, code: result.error?.code ?? application }
  }
  return { ok: true, application, restartReason: result.restartReason }
}
