# Agent Note: Integrated Web Extensions settings parent

Status: implemented

## Problem

The family settings dialog assigns one first-level navigation row to every feature. Web plugin cards, skins, pets, the Workshop and usage therefore consume five rows even though their management pages belong to the same extension area, and the long skin, pet and usage pages make that navigation cost more visible. Merging them must not break standalone package installs, existing family card seats or links that open usage directly.

## Decision

`dsh-web-settings` owns the stable first-level `settings.section` id `web-ui-plugins`, displays it as Web Extensions, and declares the keyed/root `web-ui.extension` child seat. Its parent renders installed entries in the fixed order `web-ui-plugins`, `skin-center`, `pet`, `dsh-workshop`, `dsh-usage`; the parent owns their labels, an accessible top tab strip that wraps on narrow widths, and mounts only the active keyed page. The Web Plugins child continues to declare `web-ui.plugin.item`, and the Workshop child continues to declare `dsh-workshop.panel`, so neither extension ecosystem moves.

The parent publishes `webUiExtensions` with `sectionId`, `label()` and `open(id)`. Each content plugin treats service presence as the integration verdict, listens to `slots/changed`, and migrates one registration between `web-ui.extension` and its original first-level section. Registration also waits for the target slot declaration, so the service-publication/declaration gap and declaration collapse never produce refused-registration retry loops. Keyed entries carry only `key`, locale and their business face; list-only id, order and label stay on the standalone registration. Form controllers belong to the plugin apply lifecycle rather than a seat, so migration does not reset drafts or subscriptions. `open(id)` selects the requested TAB before calling the native settings store on the stable parent id; the usage foot card retains its DOM-replay fallback with the parent id and label when native navigation is unavailable.

The usage page uses summary and trend grids, the skin page places its library beside background controls, and the pet page places visual pet choices beside grouped fields; all use narrow-container single-column fallbacks. Small N-choice controls on these pages use visible segmented groups with `aria-pressed`; the shared settings fields expose that presentation as an opt-in, leaving unrelated plugin cards on their compact select. Semantic plugin roots identify current pages for skin patches. First-level `nth-child` selectors are not a supported anchor because unrelated plugins can add or remove navigation rows.

## Alternatives considered

- Keeping independent first-level pages and only restyling their contents. Rejected: it does not reduce navigation growth or provide the requested shared extension hierarchy.
- Registering every feature permanently into a new parent without a service-gated fallback. Rejected: standalone skin, pet, Workshop and usage installs would lose their settings entry when the parent package is absent.
- Moving the existing family plugin cards or Workshop asset panels into the new keyed seat. Rejected: those seats have their own ownership and declaration lifecycles; preserving them avoids migrating unrelated contributors.
- Retaining positional navigation icons and illustrations. Rejected: the real settings navigation also contains third-party sections, so a position does not identify a feature. The parent uses the native fallback icon and semantic panel roots drive page-specific skin decoration.

## Consequences

- A full family install exposes one Web Extensions row with five secondary TABs; an individual content package without the parent keeps its original first-level row and id.
- Existing `web-ui-plugins` deep links remain valid. Usage navigation additionally selects its TAB before opening that section, including the pending selection left for DOM fallback.
- Only the active keyed page polls or renders its detailed content. Switching seats disposes the old registration before creating the replacement, with a re-entrancy latch for synchronous slot events.
- `packages/dsh-web-settings/tests/web-extensions-section.spec.tsx`, `web-ui-extensions.spec.ts`, `packages/dsh-market/tests/extension-seat.spec.ts`, `packages/dsh-usage/tests/section-integration.spec.ts` and the satellite seat suites pin TAB behavior, deep-link order and standalone/integrated migration.
- Real-GUI desktop and narrow-viewport evidence belongs to the delivery report of this change.
