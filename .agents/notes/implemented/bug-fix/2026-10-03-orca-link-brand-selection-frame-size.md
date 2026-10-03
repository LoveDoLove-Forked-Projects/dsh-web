# Agent Note: orca-link brand selection frame was sized to the row, not the wordmark

Status: implemented

## Problem

In the orca-link skin's expanded sidebar, the keyboard selection highlight around
the top-left DSH wordmark drew a box far larger than the wordmark: a thin blue
rectangle roughly twice the width of the logo, extending across empty row space
and closing over the LINK ACTIVE chip that sits beside it. The user reported the
highlight as not matching the image.

Root cause: the highlight was not the skin's. The skin replaces the host New
Session button's whole surface with the wordmark SVG, but the host button itself
is the full-width `wide` row control: measured live at 216 x 30 at the 280px
sidebar, against a wordmark of 118 x 30 anchored at the row's own 4px/15px
origin. `patches.css:1417` gives every `:focus-visible` a 2px blue outline with a
2px offset, and nothing in the orca-link sheets suppressed it on this control, so
the selection box was the button's box. The skin's own stage-frame feedback
(`body[data-orca-sidebar-wide] ... button:not([data-dsh-part="sidebar-entry"]):before`)
sits on a sibling control and never reached this button either, which is why the
mismatched host outline was the only frame the user ever saw.

## Decision

The mark's box is declared once as custom properties on `[data-orca-logo-row]`
(`--orca-mark-x/y/w/h`) and read by both the wordmark and a new selection frame, so
the two cannot drift apart again. The frame is the row's `:before` — the same
pseudo-element slot the skin already uses for the logo row's scan line — carrying
corner brackets and a faint inset rule, at half opacity for hover and full for
`:focus-visible`. The host outline is dropped on this control
(`body[data-orca-sidebar-wide] [data-orca-link-brand]:focus-visible`), so the only
frame around the mark is the one sized to it.

The frame rule names the row's first button positionally
(`:has(> button:first-of-type:is(:hover, :focus-visible))`) rather than through
`[data-orca-link-brand]`. It must opt out of the pointer, because an absolutely
positioned box paints in the positioned layer above the in-flow brand button and
would otherwise swallow clicks; the brand button has to keep every pixel of its
own hit area. The positional spelling is the same one the collapsed-rail rules
already use, and it keeps the rule out of the `orca-link-hit-targets.spec.ts`
guard's selector scan without weakening that guard.

## Testing

- Live GUI (running host on port 3080, orca-link active, dark and light sheets
  both loaded through the skin center): idle, hover and keyboard focus were
  measured and captured at 1440x900. Before the change the host outline was
  2px blue at 2px offset on a 216x30 button. After it, the frame box measures
  x=16 y=21 118x30 at opacity 0.5 on hover and 1 on focus, which equals the
  wordmark's own rect exactly on all four edges, and the button's outline-style
  is `none`. The LINK ACTIVE chip is no longer inside the highlight.
- The new session action still works: `elementFromPoint` at the wordmark centre
  resolves to the brand button, and clicking it leaves the UI on the hero
  new-session scene. No page errors.
- Collapsed rail unchanged: at 320px wide the sidebar is 56px, the wordmark is
  scaled to 0 width and hidden, and the frame rule is scoped to
  `body[data-orca-sidebar-wide]`, so nothing paints there.
- `pnpm test` (775 tests, 53 files), `pnpm typecheck`, `pnpm skin-center:check`
  and `pnpm skin-hooks:check` pass in dsh-skins.

## Alternatives considered

- **Resizing the host button to the wordmark.** Rejected: the host owns the row
  layout and the button's width is what the New Session hit area is; shrinking it
  would make the primary action easier to miss. The note from 2026-09-10 made
  the wordmark area the visible affordance, and the click surface should stay at
  least as large as the visible control.
- **Painting the frame on the button itself with an `::after`.** Rejected: the
  wide-mode rules already set the button to `position: static` and give its
  `::after` to the stage corner mark, and a frame on the button would have to be
  re-sized on every host width change to stay glued to the mark.
- **Scoping the suppression with `:has()` on the wordmark instead of the button.**
  Rejected: the trigger states have to be the button's, and the existing
  `pointer-events` guard in `orca-link-hit-targets.spec.ts` fails any rule whose
  selector text contains `[data-orca-link-brand]` next to `pointer-events: none`.
  The positional spelling is the same contract-stable selector the sheet already
  uses for this row's first control.

## Consequences

- The selection highlight now reads as the wordmark it belongs to, in both
  sidebar widths, and the fix ships with the skin assets: an installed skin picks
  it up on the next skin update or reinstall, and a page refresh is enough once
  the files change (verified live).
- The frame paints only on hover and keyboard focus, matching the stage frame the
  skin already draws for the same action; the collapsed rail, which hides the
  wordmark entirely, gets no frame.
- The custom properties on `[data-orca-logo-row]` are the single source for the
  mark's box. A future change to the wordmark size must go through them, or the
  frame and the image drift again.
