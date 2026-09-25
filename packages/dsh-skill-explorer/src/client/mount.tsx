/**
 * Panel view mounting (dsh-skill-explorer wrapper).
 *
 * The single-occupant takeover lifecycle — container injection into the center
 * column, family eviction, remount resilience, sidebar click-out — lives
 * exactly once in shared/client/panel-mount-core.ts (synced copy); this
 * wrapper supplies the skill center panel tree, view dataset key, CSS module,
 * and the html attribute names. Those names are pinned by panel.module.css,
 * skins, and the semantic attributes contract.
 */
import type { SkillApi } from './api.ts'
import type { PanelController } from './panel/controller.ts'
import { SkillPanel } from './panel/SkillPanel.tsx'
import { mountCenterPanel } from './panel-mount-core.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import css from './panel/panel.module.css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-skill-explorer-view]'

/**
 * Mount the panel React tree into the center column and bind its visibility
 * to the controller's panelOpen state.
 * @param controller - the panel controller driving the view.
 * @param api - the skill center API client the tabs operate through.
 * @param locale - locale-change source; when given, re-renders an open panel
 *   on a Language switch.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountPanel(controller: PanelController, api: SkillApi, locale?: LocaleRefreshSource): () => void {
  return mountCenterPanel({
    render: root => root.render(<SkillPanel controller={controller} api={api} />),
    viewDatasetKey: 'dshSkillExplorerView',
    pluginName: 'skill-explorer',
    viewClassName: css.view,
    activeAttribute: 'data-dsh-skill-explorer-active',
    panelName: 'skill-explorer',
    isOpen: () => controller.getSnapshot().panelOpen,
    close: () => controller.close(),
    subscribe: listener => controller.subscribe(listener),
    locale,
  })
}
