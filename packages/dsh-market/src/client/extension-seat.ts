/** Migrate the Workshop between Web Extensions and its standalone section. */

export const WORKSHOP_SECTION_ID = 'dsh-workshop'
export const WEB_UI_EXTENSION_SEAT = 'web-ui.extension'
export const LEGACY_SETTINGS_SEAT = 'settings.section'

export interface WorkshopSectionSlots {
  register(options: never, component: never): unknown
  spec?(key: string): unknown
}

export interface WorkshopSectionContext {
  slots: WorkshopSectionSlots
  get?(name: string): unknown
  on?(event: string, listener: () => void): unknown
}

export interface WorkshopSectionRegistration {
  locale: string
  label(): string
  inject(): object
  component: unknown
}

function integrated(ctx: WorkshopSectionContext): boolean {
  if (typeof ctx.get !== 'function') return false
  try {
    return ctx.get('webUiExtensions') !== undefined
  } catch {
    return false
  }
}

/** Keep exactly one registration while the optional parent loads or unloads. */
export function installWorkshopSection(ctx: WorkshopSectionContext, registration: WorkshopSectionRegistration): () => void {
  let current: string | undefined
  let dispose: (() => void) | undefined
  let reconciling = false
  let disposed = false

  const reconcile = (): void => {
    if (disposed || reconciling) return
    const target = integrated(ctx) ? WEB_UI_EXTENSION_SEAT : LEGACY_SETTINGS_SEAT
    if (current === target) return
    if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(target) === undefined) return
    reconciling = true
    const previous = dispose
    dispose = undefined
    current = undefined
    try {
      previous?.()
      dispose = ctx.slots.register((target === WEB_UI_EXTENSION_SEAT
        ? {
          name: WEB_UI_EXTENSION_SEAT,
          key: WORKSHOP_SECTION_ID,
          locale: registration.locale,
          children: { 'dsh-workshop.panel': { kind: 'keyed', scope: 'root' } },
          inject: registration.inject as never,
        }
        : {
          name: LEGACY_SETTINGS_SEAT,
          id: WORKSHOP_SECTION_ID,
          order: 150,
          label: registration.label,
          locale: registration.locale,
          children: { 'dsh-workshop.panel': { kind: 'keyed', scope: 'root' } },
          inject: registration.inject as never,
        }) as never, registration.component as never) as () => void
      current = target
    } catch (error) {
      try { console.warn(`[dsh-market] settings registration into "${target}" was refused`, error) } catch { /* best effort */ }
    } finally {
      reconciling = false
    }
  }

  if (typeof ctx.on === 'function') {
    try { ctx.on('slots/changed', reconcile) } catch { /* initial registration remains usable */ }
  }
  reconcile()
  return () => {
    disposed = true
    dispose?.()
    dispose = undefined
    current = undefined
  }
}
