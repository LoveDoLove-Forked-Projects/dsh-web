/** Integrated Web Extensions settings parent with keyed secondary TABs. */

import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WebUiExtensions } from './web-ui-extensions.ts'
import css from './web-ui-settings.module.css'

export type WebExtensionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'web-ui-plugins'>
  & PropsRenderSlots<'web-ui.extension'>
  & { extensions: WebUiExtensions }

/** Render only the selected keyed child; unavailable pages simply have no TAB. */
export function WebExtensionsSection(props: WebExtensionsSectionProps): ReactNode {
  const { t, close, renderSlot, extensions } = props
  const entries = useSyncExternalStore(extensions.subscribeEntries, extensions.getEntries, extensions.getEntries)
  const pages = useSyncExternalStore(extensions.subscribePages, extensions.getPages, extensions.getPages)
  const selected = useSyncExternalStore(extensions.subscribe, extensions.getSnapshot, extensions.getSnapshot)
  const mounted = new Set(entries.map(entry => entry.options.key))
  const tabs = pages.filter(page => mounted.has(page.key))
  const active = tabs.find(page => page.key === selected) ?? tabs[0]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const current = buttons.indexOf((event.target as HTMLElement).closest('[role="tab"]') as HTMLButtonElement)
    if (current < 0 || buttons.length === 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length
    const page = tabs[next]
    if (page !== undefined) extensions.select(page.key)
    buttons[next]?.focus()
  }

  return (
    <div className={css.extensions} data-dsh-plugin="web-ui-settings" data-dsh-part="extensions">
      <div className={css.extensionTabs} role="tablist" aria-label={t('extensions.navigation')} aria-orientation="vertical" onKeyDown={onKeyDown} data-dsh-part="tabs">
        {tabs.map(page => (
          <button
            key={page.key}
            type="button"
            role="tab"
            id={`web-extension-tab-${page.key}`}
            aria-controls="web-extension-panel"
            aria-selected={active?.key === page.key}
            tabIndex={active?.key === page.key ? 0 : -1}
            className={active?.key === page.key ? css.extensionTabActive : css.extensionTab}
            onClick={() => extensions.select(page.key)}
            data-dsh-part="tab"
            data-extension-id={page.key}
          >
            {page.label()}
          </button>
        ))}
      </div>
      <div
        className={css.extensionPanel}
        role="tabpanel"
        id="web-extension-panel"
        aria-labelledby={active === undefined ? undefined : `web-extension-tab-${active.key}`}
        data-dsh-part="panel"
      >
        {active === undefined
          ? <p className={css.extensionUnavailable}>{t('extensions.unavailable')}</p>
          : renderSlot('web-ui.extension', { close }, { entryKey: active.key, fallback: <p className={css.extensionUnavailable}>{t('extensions.unavailable')}</p> })}
      </div>
    </div>
  )
}
