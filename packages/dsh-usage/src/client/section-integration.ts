/**
 * Optional integration with the family Web UI extensions surface.
 *
 * Without that service the usage card keeps its original first-level settings
 * section. With it, the same card moves to the keyed extension seat. The live
 * service is checked again on every slot change so late activation and removal
 * migrate the one registration instead of adding a second entry.
 */

import { openUsageSettings, settingsShellStore, type SlotSeatReader } from './foot-card-mount.tsx'
import { t } from './locales.ts'

/** The original first-level settings seat and its usage entry id. */
export const USAGE_SETTINGS_SEAT = 'settings.section'
export const USAGE_SECTION_ID = 'dsh-usage'

/** The family section's keyed extension seat. */
export const WEB_UI_EXTENSION_SEAT = 'web-ui.extension'

/** Optional navigation contract published by the family extensions plugin. */
export interface WebUiExtensionsService {
  sectionId: 'web-ui-plugins'
  label(): string
  open(id: string): boolean
}

/** The context slice needed to look up the optional service. */
interface ServiceLookup {
  get?(name: string): unknown
}

/** The slot-registry member used by the section registration. */
export interface UsageSectionSlots {
  register(options: never, component: never): unknown
  spec?(key: string): unknown
}

/** The context slice needed by the migrating section registration. */
export interface UsageSectionContext extends ServiceLookup {
  slots: UsageSectionSlots
  on?(event: string, listener: () => void): unknown
}

/** The context slice needed by the foot card's settings navigation. */
export interface UsageNavigationContext extends ServiceLookup {
  slots: SlotSeatReader
}

/** The usage card contribution, independent of the seat that owns it. */
export interface UsageSectionRegistration {
  order: number
  locale: string
  label(): string
  inject(): object
  component: unknown
}

/** Read the optional service without assuming a particular cordis test double. */
export function getWebUiExtensions(ctx: ServiceLookup): WebUiExtensionsService | undefined {
  if (typeof ctx.get !== 'function') return undefined
  try {
    const service = ctx.get('webUiExtensions') as Partial<WebUiExtensionsService> | undefined
    return service?.sectionId === 'web-ui-plugins'
      && typeof service.label === 'function'
      && typeof service.open === 'function'
      ? service as WebUiExtensionsService
      : undefined
  } catch {
    return undefined
  }
}

/** Report a refused registration; a later slot change will retry it. */
function warnRefusedSeat(seat: string, error: unknown): void {
  try {
    console.warn(`[dsh-usage] settings registration into "${seat}" was refused`, error)
  } catch {
    // Console is best-effort in embedded browser surfaces.
  }
}

/**
 * Seat the usage card in exactly one place, following webUiExtensions as it
 * appears and disappears. Slot mutations emit synchronously, so the latch is
 * required to keep disposal and registration from recursively migrating twice.
 */
export function installUsageSection(ctx: UsageSectionContext, registration: UsageSectionRegistration): void {
  const component = registration.component as never
  const inject = registration.inject as never
  let dispose: (() => void) | undefined
  let current: string | undefined
  let reconciling = false

  const reconcile = (): void => {
    if (reconciling) return
    const integrated = getWebUiExtensions(ctx) !== undefined
    const target = integrated ? WEB_UI_EXTENSION_SEAT : USAGE_SETTINGS_SEAT
    if (current === target) return
    if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(target) === undefined) return
    reconciling = true
    const previous = dispose
    dispose = undefined
    current = undefined
    try {
      previous?.()
      dispose = ctx.slots.register((integrated
        ? {
          name: WEB_UI_EXTENSION_SEAT,
          key: USAGE_SECTION_ID,
          locale: registration.locale,
          inject,
        }
        : {
          name: USAGE_SETTINGS_SEAT,
          id: USAGE_SECTION_ID,
          order: registration.order,
          label: registration.label,
          locale: registration.locale,
          inject,
        }) as never, component) as () => void
      current = target
    } catch (error) {
      warnRefusedSeat(target, error)
    } finally {
      reconciling = false
    }
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('slots/changed', () => { reconcile() })
    } catch {
      // The initial seat still works if an event-less host refuses subscription.
    }
  }
  reconcile()
}

/**
 * Open usage through the family service first. If it declines, fall back to the
 * native settings shell on the family section (or on the original usage row
 * when the service is absent), preserving the matching localized nav label.
 */
export function openIntegratedUsageSettings(ctx: UsageNavigationContext): void {
  const service = getWebUiExtensions(ctx)
  if (service?.open(USAGE_SECTION_ID) === true) return
  openUsageSettings({
    id: service?.sectionId ?? USAGE_SECTION_ID,
    label: service === undefined ? () => t('usage.title') : () => service.label(),
    store: settingsShellStore(ctx.slots),
  })
}
