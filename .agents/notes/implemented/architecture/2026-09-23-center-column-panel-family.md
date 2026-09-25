# Agent Note: One center-column panel family

Status: implemented

## Problem

The `conversation` slot is single-occupant, and external plugins take the center
column over at the DOM level. Until now that occupancy was expressed pairwise:
each panel named ONE sibling's activation name and `<html>` attribute
(ssh <-> task-board), and carried a `:not([sibling])` guard in its stylesheet.

The skill center (`dsh-skill-explorer`) was a body-level overlay modal, so it
never joined that family. Moving it into the center column makes three panels
share one slot, which the pairwise shape cannot express: a panel that does not
name the third panel stays logically open while invisible, and its sidebar row
needs a second click to reopen — the exact failure the pairwise comment warned
about, now one panel further out.

## Decision

Occupancy lives in `shared/client/panel-mount-core.ts` as one table:

```ts
export const PANEL_FAMILY: readonly PanelFamilyMember[] = [
  { panel: 'taskboard', activeAttribute: 'data-dsh-taskboard-active' },
  { panel: 'ssh', activeAttribute: 'data-dsh-ssh-active' },
  { panel: 'skill-explorer', activeAttribute: 'data-dsh-skill-explorer-active' },
]
```

Opening a panel clears every other row's attribute and broadcasts its own name on
`dsh-panel-activate`; an open panel closes when the received name is not its own.
Consumers pass only `panelName` plus their own `activeAttribute` — the sibling
options are gone, and the pairwise `:not()` guards remain only as a tie-break if
two attributes ever coexist.

The skill center's browser half is now a center-column panel: `mount.tsx` wraps
`mountCenterPanel`, and `src/client/panel/` holds the shell (`SkillPanel.tsx`:
header with the back control, tab bar, content), the skills, create and edit tabs
(the edit tab appears while a skill is being edited, as the plugin's read/update
flow does), plus `panel.module.css` (renamed from `skill-panel.module.css`) in the family
vocabulary — `.panel` / `.panelHeader` / `.tabBar` / `.tab` / `.toolbar` /
`.ghostButton` / `.primaryButton` / `.linkButton` / `.badge` / `.empty` /
`.banner` / `.field` — still theme-token-only under the package's style rule.

Semantic parts follow: `card` and `head` are retired (no modal card), `tab-bar` /
`tab` / `skill-row` / `filter-bar` remain, and the `wallpaper-exclusive` skin's
skill-center anchors move from `card` + `head` to the plugin root plus
`skill-row`. The panel root joins that skin's plugin-panel glass list.

## Testing

The family lifecycle test (`packages/dsh-ssh/tests/center-panel-lifecycle.test.tsx`)
mounts all three panels and asserts that a third panel evicts whichever panel
holds the column, including the html attributes on both sides. The skill center's
own panel tests cover the shell (header, tabs, active tab), the back control
closing the controller, the last-good list policy, mutation identity, and the
create tab resolving its workspace through one list call when it is opened first.

## Alternatives considered

- **Pairwise siblings extended to three** (every panel names the other two): N²
  configuration, and each new panel must edit the other panels' mounts — the
  failure mode is a stale pairing, not a missing table row.
- **Self-contained takeover inside the skill center**, closing the other panels
  by broadcasting their names: zero cross-package edits, but the mechanism turns
  into a per-panel hack and the next panel pays the same cost again.
- **Keep the overlay modal and restyle only**: cheapest, but the panel would not
  be reachable or dismissable like the rest of the family, which is what the
  migration was for.

## Consequences

- Opening any family panel closes the other two, controller state included; the
  "second click does nothing" failure is gone by construction.
- A fourth center-column panel is one `PANEL_FAMILY` row; its own stylesheet
  still needs a guard if it wants a tie-break preference.
- The skill center has no mask-close or dismiss-on-Escape path any more: it
  closes through the back control, a sidebar session-row click, or family
  eviction. Escape only clears the search box.
- `dsh-skill-explorer` now generates a `panel-mount-core.ts` copy, so
  `scripts/sync-shared.mjs` lists three consumers for that file.
