# Agent Note: Family satellite repositories and npm consumption

Status: implemented

## Problem

The skin center, the pet plugin and the community plugin index were maintained inside this monorepo, and the market build read their assets straight out of `packages/` paths. Three costs followed from that.

A skin contributor had to open a pull request against the aggregate repository, where a new skin drowned among sixteen plugin packages, review routing for it was mixed with plugin review, and the assets were distributed only as a side effect of the next family release. The pet assets had the same shape, at 197 MB. The community index — the file that decides which third-party plugins the Workshop lists — lived in the same repository as the store that consumes it, so a one-line index update waited on a plugin release train.

The plugins were not, however, coupled in code: they never import each other or any sibling package, and the family-shared runtime modules already reached them as committed copies produced by `scripts/sync-shared.mjs`. What tied them to this repository was the toolchain and the artifact chain, not the source.

## Decision

The three plugins are maintained in their own repositories and consumed here as published npm packages:

- `@linxin666/dsh-client-ui-skin-center` — [dsh-skins](https://github.com/zhu1090093659/dsh-skins), which also carries the 42 skin assets and the skin submission surface;
- `@linxin666/dsh-pet` — [dsh-pet](https://github.com/zhu1090093659/dsh-pet), which carries the plugin plus every pet asset;
- `@linxin666/dsh-client-ui-community-plugins` — [dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins), which carries `community.json`.

Their package names are unchanged, so consumers keep resolving the same specifiers.

The aggregate mounts them through `rows:` (external npm rows) with explicit semver ranges instead of `patchFrom`/`deps`, and `packages/dsh-web-all/package.json` declares the three dependencies by hand. Row ids stay byte-identical to the `patchFrom` era (`web-ui-pet`, `web-ui-skin-center`, `web-ui-community-plugins`), so existing profiles need no migration. The subpath exports those rows used to mount (§ `./pet`, `./skin-center`, `./community-plugins`) remain in the exports map as `tombstones:`, so a profile that recorded `@linxin666/dsh-web-all/pet` still imports instead of throwing `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### External rows trade fault isolation for independence

An external row mounts the real package name directly: it carries no `config.plugin` and is not wrapped by the aggregate's fault-isolation shell, and its browser half is no longer inlined into the aggregate's client bundle. The shell exists so that one broken family plugin cannot take the whole boot down, and the three rows give that up. In exchange their client half is mounted by the loader from their own loader entry, their source changes no longer force a rebuild of `dsh-web-all/lib`, and `packages/dsh-web-all/AGENTS.md` records the new contract.

`tests/satellite-rows.spec.ts` pins the invariants that keep the trade safe: the row ids, the direct mount (no `config.plugin`), the declared semver range, the `./package.json` export that `scripts/aggregate.mjs` resolves an external row through, the surviving compat tombstones, the `remote-web-ui`-before-`pet` ordering, and the absence of the three from the client-children list.

### Market content is pinned by commit

The market build does not read skin or pet assets — or the community index — from a working tree. The three content repositories are git submodules under `satellites/`, and a submodule's gitlink is the pin: `market-inputs.lock.json` maps each input to the submodule carrying it and to the content directory inside it, `scripts/market-fetch-inputs.mjs` materializes that directory into `.market-inputs/` (copying a working tree that sits on the pinned commit, otherwise downloading that commit as a tarball; idempotent, `--check` verifies without downloading, a missing or stale input fails the run), and `scripts/market-build` reads from there. The community index is pinned the same way rather than resolved from whatever npm happens to publish: before that, deleting the in-repo package made the build silently read a stale published index and produce a `manifest/plugins.json` that no longer matched the committed `market/dist`.

`scripts/market-verify-assets.mjs` walks every path the emitted manifests advertise and checks it against `market/dist` or a deployed origin, comparing the served byte length with the local file. It needs a ranged GET rather than HEAD because the Workers static-asset layer answers HEAD with `content-length: 0`. The deploy workflow fetches before `market:check` and verifies against `dsh-market.com` after the deploy.

That post-deploy walk runs from a GitHub runner, and the edge answers part of it with 403: six consecutive runs reported the same ~150 paths, a serial re-check recovered none of them after a three-minute probe, and those exact paths answer 200 with the committed byte lengths from a residential network, from two public cloud fetchers, and across a full 3075/3075 local sweep. The refusal is therefore a policy on that vantage rather than a verdict about the assets, so the walk retries transient statuses inside the burst, re-checks the survivors one at a time, and names an all-403 sweep as a vantage refusal in its output: a red lane on a market push is read as the zone's policy on the runner range, and the deployed artifacts remain covered by `market:check` against the pinned inputs plus a sweep from a network the policy allows, until that range is allowed deliberately or the check moves to a vantage inside Cloudflare.

### Release order

The satellites release before this repository switches, because the aggregate mounts them as npm rows and the mount smoke asserts the registry path. `@linxin666/dsh-web-all` depends on the three satellite packages by semver range, and each satellite carries its own version line: the `0.3.25` releases hold the 0.1.7-rc.1 migration that removed the retired `settingsScope` inject, so the aggregate's mount smoke (`scripts/e2e-mount.sh`) is green on the registry path while its `FAMILY_TGZS_DIR` override covers the packages this repository builds.

## Alternatives considered

**Mirror repositories generated from this monorepo.** Push read-only mirrors of the three directories to their own GitHub repositories and keep this repository as the only source. Cheapest to operate and it delivers the discovery goal, but it fails the contribution goal: a pull request against a mirror has nowhere to land, so skin contributions would still arrive here and the mirrors would be decoration.

**Git submodules at the current paths.** Keep the three packages in the workspace as submodules so the aggregate and the market build keep working unchanged. Rejected because the aggregate was to consume published packages, not a working tree: a submodule would have kept the workspace link, the client inlining and the rebuild coupling in place, and it adds detached-HEAD friction to every contributor clone. The rejection is about mounting them as workspace packages: the same mechanism outside the workspace is what pins their market content, because the workspace globs never reach `satellites/` and a clone that leaves the submodules uninitialized still builds the market from the pinned tarballs.

**Extract only the assets and keep the plugins in-repo.** Move skins and pet assets to content repositories while the plugins stay here. Rejected because the plugin and its content share a contract (`skin.json`, `pet.json` v2) and a test suite; splitting them across repositories would have put the validation in a different repository from the thing it validates.

**Publish the shared build preset and runtime modules as packages.** Have the satellites depend on a published `shared/` instead of carrying vendored copies and their own copy of `shared/tsdown.client.ts`. Rejected for this change: the repository deliberately chose committed copies so every package stays self-contained for typecheck, test and publish, and reversing that policy is its own decision with its own blast radius. The satellites carry the preset and the copies, and drift is checked where it is cheap.

**Keep the three in-repo and rely on CODEOWNERS and labels.** The cheapest option, and it addresses review routing but not distribution: contributors would still fork and clone a monorepo to add one skin, and the unified family version would still gate every skin release.

## Consequences

- Three repositories own their own CI, their own version line and their own contribution flow; this repository's release no longer publishes them, and `release.yml` / `scripts/lib/family-packages.mjs` see sixteen packages instead of nineteen.
- The three rows lose the aggregate's fault-isolation shell, and their plugin-inventory titles change from `web-all/<family>` to their own package names.
- The SDK cohort is now advanced in four repositories instead of one; the satellites were synced to `0.1.7-rc.1` after this split, and a future cohort move has to touch all four.
- The market site's content follows the submodule gitlinks: a merged skin or pet change reaches `dsh-market.com` when a maintainer moves the `satellites/` submodule onto that commit and the deploy workflow rebuilds and re-verifies, not when the satellite merges.
- `satellites/` records the three submodules but not their contents, so a clone that never initializes them still builds the market; `git submodule update --init` is the opt-in for working on satellite content in place, and a contributor who skips it pays no clone cost for the 199 MB pet repository.
- `.market-inputs/` is fetched build input (git-ignored), and the test-standards and emoji audits skip it and `satellites/` so satellite content is not audited as first-party code.
- The satellites carry a copy of `shared/tsdown.client.ts` and the vendored `shared/` modules; `scripts/sync-shared.mjs` now covers 99 copies instead of 114 and no longer reaches the three.
