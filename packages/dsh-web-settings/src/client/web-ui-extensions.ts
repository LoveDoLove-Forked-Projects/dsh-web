/**
 * Cross-plugin contract for the integrated Web Extensions settings section.
 * The service is the availability signal: satellite plugins seat their page in
 * web-ui.extension while it exists and keep their standalone section otherwise.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export const WEB_EXTENSIONS_SECTION_ID = 'web-ui-plugins'
export const WEB_EXTENSIONS_SLOT = 'web-ui.extension'

interface SettingsShellStore {
  create(): { actions: { openSection(id: string): void } }
}

/** Public face consumed through ctx.get('webUiExtensions'). */
export interface WebUiExtensionsFace {
  readonly sectionId: typeof WEB_EXTENSIONS_SECTION_ID
  label(): string
  open(id: string): boolean
}

/** Owns TAB selection and native settings-shell navigation for the parent. */
export class WebUiExtensions extends Service implements WebUiExtensionsFace {
  readonly sectionId = WEB_EXTENSIONS_SECTION_ID
  private selected = WEB_EXTENSIONS_SECTION_ID
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'webUiExtensions')
    ctx.effect(() => () => { this.listeners.clear() }, 'web-ui-settings: extension selection')
  }

  label(): string {
    return this.ctx.locale.bind('web-ui-plugins')('extensions.title')
  }

  getSnapshot = (): string => this.selected

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeEntries = (listener: () => void): (() => void) => this.ctx.slots.subscribe(WEB_EXTENSIONS_SLOT, listener)

  getEntries = (): readonly StoredEntry[] => this.ctx.slots.entries(WEB_EXTENSIONS_SLOT)

  select(id: string): void {
    if (this.selected === id) return
    this.selected = id
    for (const listener of this.listeners) listener()
  }

  open(id: string): boolean {
    // Select first: even a shell without an exposed store keeps the requested
    // TAB ready for its DOM-replay fallback.
    this.select(id)
    try {
      const slots = this.ctx.slots as unknown as { entries(key: string): readonly { store?: unknown }[] }
      const store = slots.entries('sidebar.settings')[0]?.store as SettingsShellStore | undefined
      if (typeof store?.create !== 'function') return false
      store.create().actions.openSection(this.sectionId)
      return true
    } catch {
      return false
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Integrated Web Extensions settings parent provided by dsh-web-settings. */
    webUiExtensions: WebUiExtensions
  }
}
