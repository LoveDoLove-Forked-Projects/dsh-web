# Agent Note: Plugin display metadata via locale files and localized aggregate family titles

Status: implemented

> Note: This decision supersedes the earlier retired-plugin retention in [Generate the aggregate's retired-plugin registry from its manifest](../bug-fix/2026-10-17-aggregate-retired-plugin-registry.md): the five retired families are completely excised rather than retained in tombstones, exports, and the retirement registry.

## Problem

The official Plugins list (Settings → Plugins) rendered standalone packages with bare npm package names (such as `@linxin666/dsh-web-settings`) and their English `package.json.description`. In the aggregate bundle (`@linxin666/dsh-web-all`), family rows mounted as subpath exports displayed row titles derived from the mount specifier label `web-all/<family>` ([Aggregate family rows display real plugin names via subpath exports](../architecture/2026-09-02-aggregate-family-row-display-names.md)), rather than user-friendly localized names. Furthermore, four packages (`dsh-browser-view`, `dsh-task-board-remote`, `dsh-task-board-team`, and `dsh-win-bash`) lacked `icon.svg`, displaying generic placeholder artwork. Finally, five previously retired families (`describe-image`, `desktop-launcher`, `doctor`, `dsh-perf`, and `model-capabilities`) retained vestigial tombstone shells, retirement entries, and exports mappings that complicated manifest maintenance.

## Decision

All family packages, the root bundle, and the aggregate bundle adopt the official DSH display metadata channel, deliver complete icon assets, switch aggregate family rows to localized titles, and fully excise the five retired families.

### Official metadata channel and strict exports parity

The host (`@deepseek-ai/dsh-app-boot` via `readPluginMeta`) resolves row titles and gray descriptions from `<specifier>/locale/<lang>.json` (`meta.title` and `meta.description`). The host resolution order is strict: it first attempts to resolve `<specifier>/locale/en.json`, and then enumerates every `*.json` file present in that directory, resolving each one through the package's `exports` map.

On-disk files and `./locale/<lang>.json` exports keys must correspond strictly one-to-one. If a file exists on disk without a corresponding export key, or an export key is declared without a disk file, the host throws a metadata resolution error and silently falls back to the package's npm name and English `package.json.description`.

### Package-level scope and language fallback

Under `packages/` there are 23 packages in total (22 child packages plus the aggregate `dsh-web-all`). This update completed `locale/en.json` and `locale/zh.json` for 21 plugin packages; two existing packages (`dsh-agents` and `dsh-remote-bridge`) already carried locale directories and include `ru.json`. Every package exports its `./locale/<lang>.json` files and whitelists `"locale"` in `package.json.files`. The 21 packages completed in this update ship only `zh` and `en` (the two existing packages also ship `ru.json`). When a user runs in another language without a dedicated locale file, the host automatically falls back to `en`. Russian dictionaries for plugin UI strings remain centralized in `packages/dsh-i18n`.

The repository root bundle (`package.json`, name `dsh-web`, private, mounting the aggregate patch) also ships `locale/zh.json` ("全家桶" / "一键装齐 DSH Web 官方插件") and `locale/en.json` ("Web bundle" / "Install every DSH Web plugin in one step.") with `"locale"` in `files`. Because the root bundle has no `exports` field, the host resolves its metadata directly by filesystem path, requiring no export keys; the test gate `scripts/plugin-display-metadata.test.mjs` scans `packages/*` and intentionally excludes the root bundle from exports parity checks.

The host reads display metadata on demand per request. Edits to locale files take effect immediately upon refreshing the browser page, with no host restart required.

### Icon completion

The four packages previously missing icons (`dsh-browser-view`, `dsh-task-board-remote`, `dsh-task-board-team`, and `dsh-win-bash`) now include the standard family `icon.svg` (byte-identical with `packages/dsh-web-all/icon.svg`), declare top-level `package.json.icon`, and include `"icon.svg"` in `files`. All family packages and the aggregate now provide complete card artwork.

### Localized aggregate family row titles

Aggregate family rows no longer display the specifier tag `web-all/<family>`. In `packages/dsh-web-all/aggregate.yml`, each `shellNotes` entry now declares `title: {zh, en}` alongside description text. The generator (`scripts/aggregate.mjs`) writes this into `shell-metadata/<family>/locale/<lang>.json` as `meta.title` (falling back to `en` when no distinct `ru` title is defined). Crucially, following issue #1901 (2026-10-18), `cordis.patch.yml` mounts modern family rows directly under their real package names, so row titles on the official Plugins page are resolved from each real package's own locale files; the localized titles generated into `shell-metadata` apply only to legacy profiles that still name rows using the subpath specifier `@linxin666/dsh-web-all/<family>`.

This partially supersedes [Aggregate family rows display real plugin names via subpath exports](../architecture/2026-09-02-aggregate-family-row-display-names.md): it replaces only the decision that the row title is the mounted specifier tag `web-all/<family>`. The subpath exports and fault-isolation shell mechanisms remain active for legacy rows.

The generator enforces fail-closed validation: missing titles, unknown family IDs, duplicate IDs, identical Chinese and English titles (Latin product names like "Windows Bash" are permitted), Chinese descriptions lacking Han characters, descriptions exceeding 20 Han characters, or descriptions identical to English all abort generation.

### Complete removal of five retired families

Five retired families (`describe-image`, `desktop-launcher`, `doctor`, `dsh-perf`, and `model-capabilities`) are completely removed from the aggregate package:

- Entries in `aggregate.yml` for `shellNotes`, `tombstones`, and `retiredPlugins` are deleted.
- Generated `shell-metadata/<family>/` directories are deleted.
- 25 exports keys (5 subpaths, 5 icons, and 15 locale files) are removed from `packages/dsh-web-all/package.json`.

Cost and tradeoff: Stale user profiles that still reference `@linxin666/dsh-web-all/<family>` for any of these five families will now fail at import time with an unresolvable export and be recorded as failed or degraded imports, rather than mounting a silent no-op shell. The host does not halt startup: upstream `auditStartupEntries` only throws `StartupError` for required entries; non-required plugin entries emit a warning while sibling plugins continue running normally. The `retiredPlugins:` section header and shell skip mechanism remain in place as an empty list for future plugin retirements (currently an empty registry with tests asserting absence across all surfaces).

## Alternatives considered

- Shipping `ru.json` in every package: Rejected. Standalone UI translations centralize Russian in `packages/dsh-i18n` to avoid sprawling maintenance across packages. The host's built-in fallback to English provides acceptable degradation for display metadata, whereas aggregate subpaths require local Russian metadata files because they cannot be addressed by `dsh-i18n`.
- Reading custom fields from `package.json`: Rejected. The host's official contract in `dsh-app-boot` explicitly targets `<specifier>/locale/<lang>.json`. Inventing bespoke fields like `package.json.dsh.display` would be ignored by the official plugin management UI.
- Retaining tombstone shells for the five retired families: Rejected. Keeping 25 exports keys and metadata directories indefinitely imposes maintenance overhead and obscures active subpaths. A clean break ensures that reintroducing any of these surfaces requires an explicit product decision.

## Consequences

- New packages must ship both `locale/{en,zh}.json` and `icon.svg`, declare both in `package.json.exports` and `package.json.files`, and keep Chinese descriptions under 20 Han characters, or the plugin list falls back to bare package names.
- Stale user profiles referencing removed family subpaths experience import failures recorded as degraded/failed imports, while the host logs a warning and continues running sibling plugins.
- Display metadata updates are live and visible immediately on browser page refresh without restarting `dsh web`.

## Testing

- `scripts/plugin-display-metadata.test.mjs` verifies that every package in `packages/` has matching disk files and exports keys for `locale/`, non-empty `meta.title` and `meta.description`, valid Chinese descriptions under 20 Han characters, and an in-package icon under 256 KiB in `files`.
- `scripts/aggregate.test.mjs` asserts that none of the five retired families exist in patch rows, tombstones, retired plugins, shell notes, or package exports, and verifies shell metadata parity.
- Both test suites execute and pass under `pnpm test:scripts`.
- Live inspection on the running DSH Web GUI confirmed that refreshing the page immediately updated the root bundle row title and description to "全家桶" and "一键装齐 DSH Web 官方插件".
