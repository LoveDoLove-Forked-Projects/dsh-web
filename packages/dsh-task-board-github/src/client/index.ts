/**
 * Browser half of the task-board GitHub provider extension.
 *
 * It registers the extension's copy, contributes one settings card to the
 * plugin-card seat the running host renders, and installs the provider's three
 * child seats into the task board. Both halves of the extension's own switch
 * are followed live: the seats appear and disappear with the settings form's
 * `enabled` value, while the settings card itself stays reachable so the
 * switch can be turned back on.
 *
 * Failure policy: a missing slot, settings surface, or board service is
 * handled, never thrown — the web shell fails the whole boot when a plugin
 * apply throws, and one external plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the settings-surface Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GithubSettingsCard, GithubSettingsCardController, type GitHubSettings } from './GithubSettingsCard.tsx'
import { installGitHubClientHalf, type ExtensionEnabledSource } from './github/extension.ts'
import { en, setRuntimeTranslate, zh, type TaskBoardGithubKey } from './locales.ts'
import { installPluginCard } from './plugin-card-seat.ts'
import { createServedEntryForm } from './settings-entry-form.ts'

/** Locale namespace this half owns. */
export const NS = 'task-board-github'

/**
 * Settings namespace the card edits: the family identity of this extension's
 * own settings form, and the row id a standalone bundle install carries.
 */
export const SETTINGS_NAMESPACE = 'task-board-github'

/** npm package name of this bundle: the key of the official plugin-card seat. */
const BUNDLE = '@linxin666/dsh-client-ui-task-board-github'

/**
 * Profile entry id the family aggregate's generated row carries — the shape
 * nearly every user runs, and the id the shared-forms fallback binds when the
 * family binder cannot resolve the namespace.
 */
const AGGREGATE_ENTRY_ID = 'web-ui-task-board-github'

/** Profile entry ids this package's patch rows carry, most specific first. */
const ENTRY_IDS: readonly string[] = [AGGREGATE_ENTRY_ID, 'ui-task-board-github', SETTINGS_NAMESPACE]

/**
 * The family settings binder published by dsh-web-settings; absent when that
 * group plugin is not installed.
 */
interface SettingsFormBinder {
  /** Resolve this package's family namespace onto the row the Host serves. */
  bind<T>(spec: { namespace: string }): ConfigForm<T>
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The child slot the Web UI plugin group declares; this card registers into
     * the group's list seat rather than the official bundle-configuration seat.
     * Declared here so this package needs no dependency on the sibling UI
     * package.
     */
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginItemOwnerProps }

    /** Provider task-detail section; the board declares and renders it. */
    'task-board.detail.section': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardDetailSectionProps }
    /** Provider settings section; the board declares and renders it. */
    'task-board.settings.section': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardSettingsSectionProps }
    /** Provider card decoration; the board declares and renders it. */
    'task-board.card.decoration': { kind: 'list'; scope: 'root'; owner: import('../core/contract.ts').TaskBoardCardDecorationProps }
  }

  interface LocaleNamespaceMap {
    /** The GitHub provider extension copy. */
    'task-board-github': TaskBoardGithubKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional family settings binder provided by dsh-web-settings; absent when
     * that group plugin is not installed, so callers bind the shared forms
     * service (`ctx.configForms`) by profile entry id directly.
     */
    webUiSettings?: SettingsFormBinder
  }
}

/**
 * Required client services: the slot registry, the locale catalog, and the
 * shared configuration forms the card stages over.
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Bind the settings form the card stages over.
 *
 * The family binder comes first: it resolves this package's family namespace
 * onto the profile entry id the Host serves the form under. A page without that
 * group binds through the shared forms service on the entry id the describe
 * mirror justifies, rebound as soon as the mirror answers.
 * @param ctx - the browser plugin context.
 * @returns the form the settings card reads and writes.
 */
export function bindSettingsForm(ctx: ClientContext): ConfigForm<GitHubSettings> {
  const binder = ctx.get('webUiSettings')
  if (binder !== undefined && typeof binder.bind === 'function') {
    return binder.bind<GitHubSettings>({ namespace: SETTINGS_NAMESPACE })
  }
  return createServedEntryForm<GitHubSettings>({
    forms: ctx.configForms as ConfigForms,
    entryIds: ENTRY_IDS,
  })
}

/**
 * A form for a page that serves this namespace to nobody: it never answers, so
 * the card explains the missing namespace instead of pretending to be broken,
 * and the seats still follow the documented default (enabled).
 * @returns an inert configuration form.
 */
function unavailableForm(): ConfigForm<GitHubSettings> {
  const snapshot: ConfigFormSnapshot<GitHubSettings> = {
    status: 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'host',
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
 * Mount the extension's browser half: the dictionaries, the settings card, and
 * the provider's child seats.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'task-board-github: dictionaries')

  // Wire the SDK translate seat into the module-level t the child seats use:
  // it reads the active locale at call time, so the seats follow a runtime
  // language switch without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(NS)) } catch { /* locale missing: document-language fallback stays */ }

  let scope: ConfigForm<GitHubSettings>
  try {
    scope = bindSettingsForm(ctx)
  } catch {
    // No settings surface on this page: the card is unavailable, but the
    // provider's seats stay on their documented default.
    scope = unavailableForm()
  }

  // The seats follow the extension's own master switch, live: the settings form
  // is the same volatile reference the Host commits an edit into.
  const enabledSource: ExtensionEnabledSource = {
    read: () => scope.getSnapshot().value?.enabled !== false,
    subscribe: listener => scope.subscribe(listener),
  }
  ctx.effect(() => installGitHubClientHalf(ctx, enabledSource), 'task-board-github: provider seats')

  let controller: GithubSettingsCardController
  try {
    controller = new GithubSettingsCardController(scope)
  } catch {
    // A form that cannot be staged over: the extension keeps its seats and
    // loses only the card.
    return
  }

  // Card seat: the family group's list seat, or the official
  // bundle-configuration seat when the group is not installed. A refused seat
  // is reported by the seat helper and leaves every other surface working.
  try {
    installPluginCard(ctx, {
      bundle: BUNDLE,
      id: SETTINGS_NAMESPACE,
      order: 130,
      locale: NS,
      inject: () => controller.inject(),
      component: GithubSettingsCard,
    })
  } catch {
    // A slot registry that refuses the contribution: the card stays absent.
  }
  ctx.effect(() => () => { controller.dispose() }, 'task-board-github: settings card')
}
