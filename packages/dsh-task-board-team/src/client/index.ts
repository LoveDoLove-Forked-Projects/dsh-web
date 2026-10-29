/**
 * Browser half of the task-board team provider extension.
 *
 * It registers this extension's copy, then contributes three seats: the card
 * decoration and the task-detail section (both behind the extension's own
 * switch, which is read from the settings form), and the configuration block
 * inside the board's own settings card (behind the board service alone, because
 * that block is where the switch and the Host Token live).
 *
 * Failure policy: a missing slot registry, locale service or board service is
 * handled, never thrown — the web shell fails the whole boot when a plugin apply
 * throws, and one external plugin must not take the GUI down.
 *
 * @module dsh-task-board-team/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the settings-surface Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { installTeamClientHalf, type ExtensionEnabledSource } from './team/extension.ts'
import { en, setRuntimeTranslate, t, zh, type TeamKey } from './locales.ts'

/** Locale namespace this half owns. */
export const NS = 'task-board-team'

/** Settings namespace the block edits. */
export const SETTINGS_NAMESPACE = 'task-board-team'

/** Profile entry ids this package's patch rows carry, most specific first. */
export const ENTRY_IDS: readonly string[] = ['web-ui-task-board-team', 'ui-task-board-team', SETTINGS_NAMESPACE]

/** The settings value this extension's own form carries. */
export interface TeamSettingsValue {
  enabled?: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Provider task-detail section; the board declares and renders it. */
    'task-board.detail.section': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardDetailSectionProps }
    /** Provider settings section; the board declares and renders it. */
    'task-board.settings.section': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardSettingsSectionProps }
    /** Provider card decoration; the board declares and renders it. */
    'task-board.card.decoration': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardCardDecorationProps }
  }

  interface LocaleNamespaceMap {
    /** The team provider extension copy. */
    'task-board-team': TeamKey
  }
}

/**
 * A form for a page that serves this namespace to nobody: it never answers, so
 * the seats follow the documented default (enabled) instead of failing.
 * @returns an inert configuration form.
 */
function unavailableForm(): ConfigForm<TeamSettingsValue> {
  const snapshot: ConfigFormSnapshot<TeamSettingsValue> = {
    status: 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => false,
    unset: async () => false,
    mutate: async () => false,
  }
}

/**
 * Bind the settings form this extension's switch is read from.
 * @param ctx - the browser plugin context.
 * @returns the form, or an inert one when the page serves no such namespace.
 */
function bindSettingsForm(ctx: ClientContext): ConfigForm<TeamSettingsValue> {
  const forms = (ctx as { configForms?: { describe?: unknown } }).configForms
  if (forms === undefined) return unavailableForm()
  const binder = (ctx as { webUiSettings?: { bind?: <T>(spec: { namespace: string }) => ConfigForm<T> } }).webUiSettings
  if (binder !== undefined && typeof binder.bind === 'function') {
    try {
      return binder.bind<TeamSettingsValue>({ namespace: SETTINGS_NAMESPACE })
    } catch {
      return unavailableForm()
    }
  }
  return unavailableForm()
}

/**
 * Mount the extension's browser half.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'task-board-team: dictionaries')

  // Wire the SDK translate seat into the module-level t the seats use, so a
  // runtime language switch reaches them without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(NS) as (key: TeamKey) => string) } catch { void t }

  const scope = bindSettingsForm(ctx)
  const enabledSource: ExtensionEnabledSource = {
    read: () => scope.getSnapshot().value?.enabled !== false,
    subscribe: listener => scope.subscribe(listener),
  }

  ctx.effect(() => installTeamClientHalf(ctx, enabledSource), 'task-board-team: provider seats')
}
