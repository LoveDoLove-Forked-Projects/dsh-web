# Agent Note: Liangshen preset child-model selection opt-in

Status: implemented

## Problem

`packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` derived its delegation rows from the builtin presets but dropped one key while copying them: neither `tool-subagent` nor `tool-subagent-fork` set `modelSelectionSettings`. Upstream `@deepseek-ai/dsh-tool-subagent` reads that key as a per-row opt-in (`modelSelectionSettings: z.boolean().default(false)`), and every consequence of the opt-in hangs off it:

- the delegation tool publishes no `provider` / `model` / `reasoning_effort` parameters, so an explicit child route fails at call time with `child model selection is disabled for this tool instance`;
- the tool description never carries the `Child LLM selection is optional` sentence and `list_subagent_models` is never registered, so the model has no discovery path;
- the web settings page subagent model-selection toggle therefore reads as dead under this preset even though the host owns the settings service (`subagent-model-selection-settings`, mounted by the official `dsh-web-app` host bundle).

Every official preset that ships delegation rows sets the key on the spawn row (`standard.patch.yml`, `ptc.patch.yml`, `cordis.patch.yml`), so the shipped Liangshen roster was the outlier.

## Decision

The `tool-subagent` row carries `modelSelectionSettings: true`, matching the builtin Standard, PTC, and Cordis presets. The `tool-subagent-fork` row does not, and it must not:

- upstream registers the discovery tool under the FIXED name `list_subagent_models` (`registerListSubagentModels` in `packages/subagent/tool-subagent/src/list-models.ts`) into the scope the row composes into;
- a preset-scope row installs per composed Agent through `candidate.ctx.inject(...)`, so every opt-in row reaching the same composition scope registers that one name into the same Agent scope;
- the tool registry rejects a duplicate name inside one scope: `NamedEntries.insert` throws from its duplicate factory, with the message `tool "list_subagent_models" is already registered in this scope`. A second opt-in row therefore fails session composition outright instead of adding a second opt-in.

So the shipped invariant is: exactly one delegation row per composition scope may opt in, and the fork row is precisely the row a maintainer would complete by mistake. The constraint is written into the preset file beside the row, and `tests/preset-composition.test.ts` counts the opt-ins structurally over the parsed composition (descending into group rows) rather than only pinning the spawn row text, plus a mutation check that injects a second opt-in into the fork row and asserts the guard counts it.

Verified on the cohort this package pins (`>=0.2.0-rc.2`): the schema, the fixed-name registration, and the per-scope install path are identical in the `0.2.0-rc.2` source and in the published `0.1.2-rc.1` and `0.1.7-rc.1` packages.

## Testing

- `packages/dsh-liangshen/tests/preset-composition.test.ts` fails before the fix (the spawn-row assertion, 1 failed / 11 passed) and passes after it (12 passed).
- The structural half asserts the opt-in row ids are exactly `['tool-subagent']`, and that the same assertion reports `['tool-subagent', 'tool-subagent-fork']` once the fork row is given the flag, so the guard cannot pass vacuously.
- `pnpm --filter @linxin666/dsh-liangshen test` and `pnpm --filter @linxin666/dsh-liangshen typecheck` pass; `pnpm docs:check`, `pnpm i18n:check`, and `pnpm test:standards` pass.
- No live GUI evidence: the preset change needs a full `dsh web` restart to take effect, and the running host was left untouched.

## Alternatives considered

- Opt in on both the spawn and the fork row so every delegation tool could pick a route. Rejected: it is exactly the configuration that makes the whole session fail with `tool "list_subagent_models" is already registered in this scope`, and the fork provider would gain nothing the spawn row does not already provide (it does declare the `agentOptions` capability, so capability is not the blocker).
- Patch upstream to register the discovery tool idempotently, or under a per-tool name. That is the right fix, but it belongs to `@deepseek-ai/dsh-tool-subagent`, and this repository never modifies the harness or its SDK packages. It is filed upstream instead; the preset-side comment and test keep the local roster correct until it lands.
- Declare a preset-local `agentOptions` block (`provider` / `model` / `reasoningEffort` / `maxTokens` are the real upstream field names, confirmed in the installed schema) to pin a default child route instead of enabling model-facing selection. Rejected: it does not restore the settings toggle the issue is about, and it would silently force one child route for every delegation. The key stays unset; it remains a valid separate choice for an operator who wants exactly that.
- Omit the opt-in and document the limitation. Rejected: it leaves the reported defect in place on a preset whose upstream counterpart carries the flag.

## Consequences

- The web settings page child-model selection toggle is honored under Liangshen mode: with the host settings enabled, the model sees the route parameters on `subagent` and can call `list_subagent_models`; an explicit route is checked against the Session allowed list.
- The flag is per row, not per preset, so the fork row stays route-inheriting until upstream makes the discovery registration idempotent. Anything that wants a forkable child on another route needs the upstream fix.
- The preset file now carries a comment that outlives this issue: the one-opt-in-per-scope rule is stated with the failure it prevents, so the next maintainer does not read the missing fork flag as an oversight.
