# Agent Note: Task-board team client half probes its services instead of reading them

Status: implemented

## Problem

The rc.3 web shell fails its whole boot on one plugin whose apply throws. The failure surfaced on the desktop app as `web boot: 1 entry did not activate` / `@linxin666/dsh-client-ui-task-board-team: failed`, with the dialog's only offer being a reinstalled-application path — the GUI never rendered.

The cause is the shell context's service contract. A cordis 4 context resolves a service to its implementation only when the reading plugin declared that name in its `inject`; an undeclared property read does not answer `undefined`, it throws `cannot get property "<name>" without inject`. The team browser half declares no `inject` at all — it is written to tolerate a deployment without a settings surface, so it read its collaborators as plain properties:

- `bindSettingsForm` read `ctx.configForms` first, and `ctx.webUiSettings` after it
- `installTeamClientHalf` read `ctx.slots` as the seat registry
- `apply` read `ctx.locale` for its dictionaries and its translate seat

Only `bindSettingsForm`'s read was unguarded, so it was the first to throw; the other two sat behind `try`/`catch` blocks that hid the same defect behind a silent no-op. The module's own documentation promised "a missing slot registry, locale service or board service is handled, never thrown", which was true of the values it expected and false of the access that produced them.

The same class of defect was fixed once before in the shared pairing fence (issue #1942, [issue batch 1937-1942](2026-10-24-issue-batch-1937-1942-fixes.md)): a property fallback on an un-injected service throws rather than answering nothing.

## Decision

`packages/dsh-task-board-team/src/client/optional-service.ts` owns one `optionalService(ctx, name)` helper: it resolves the name through `ctx.get` inside a `try`/`catch` and answers `undefined` when the shell serves nothing. Both client modules read their collaborators through it — `configForms`, `webUiSettings` and `locale` in the entry, `slots` in the installer.

- No `inject` is declared on the client entry. Declaring one would turn the plugin's tolerance into a hard dependency: the fiber would sit pending until every seat is served, and a deployment with no settings surface would lose the board's decoration and detail seats as well.
- `ctx.inject(['taskBoard'], ...)` for the board capability face stays as it is. It is a runtime dependency scope, not a static inject entry, and the face is resolved through `resolveTaskBoardClientFace`, which already probes with `ctx.get`.
- A page that serves no slot registry now returns an empty disposer instead of registering seats: the provider loses its own contributions and the board keeps rendering.

The tolerance the module documents is now a property of the access, not of the value: an undeclared or unserved service answers "nothing here" and never reaches the boot check.

## Alternatives considered

Declaring `export const inject = ['slots', 'locale', 'configForms']` on the client entry, as the board's own entry does, was rejected. The board needs its seats; this provider is optional decoration, and a hard inject list would keep its fiber pending forever on a page that serves no settings surface — which converts today's boot failure into a silently missing feature on every such page.

Keeping the property reads and wrapping each one in `try`/`catch` was rejected as the primary shape: it repeats the access rule at every call site and leaves the next collaborator to rediscover it. The one helper keeps the rule in a single place the tests can point at.

Relying on the shell to soften the error, or on `inject` plus optional dependencies, was rejected because it is not this repository's surface: the shell's contract is fixed by the SDK cohort, and the plugin must work on the cohort it ships against.

## Consequences

The desktop app boots again on 0.2.1-rc.3 with this profile: the board, the team seats and the settings block all mount, and no entry fails the boot check.

The provider degrades by subtraction. Without a slot registry it registers nothing; without a settings surface its switch reads as enabled and its seats still mount; without the board service it keeps the settings block — the place where the switch and the Host Token live — and drops the rest.

Any future client service this package reads must go through `optionalService` or a declared `inject`. Reading a name as a property is now a boot failure, not a `undefined` check.

## Testing

`pnpm --filter @linxin666/dsh-client-ui-task-board-team test`: 86 tests pass across 10 files, including two new cases in `tests/client.spec.ts` under `boot tolerance`. They build a shell context with the inject contract enforced — a `Proxy` that throws `cannot get property "<name>" without inject` for every service property the plugin never declared, and answers only `ctx.get` — then assert `apply` does not throw and the settings block is registered through the probed registry. Before the fix this context reproduced the shipped error verbatim. The existing seat specs were updated to answer `slots` through `ctx.get`, which is what the real shell does.

`typecheck` and `build` pass for the package.

Reproduction on the shipped runtime: a probe home (`DSH_HOME=/tmp/...`, profile copy of the desktop profile) booted with the desktop app's own CLI on port 64991, loaded in headless Chrome through Playwright. Before the fix the page rendered "Failed to load plugins / @linxin666/dsh-client-ui-task-board-team / web boot: 1 entry did not activate"; after the fix the GUI rendered, `window.__dshTaskboardApplied` was `true`, and no boot error appeared. The probe instance and its home were removed after verification.
