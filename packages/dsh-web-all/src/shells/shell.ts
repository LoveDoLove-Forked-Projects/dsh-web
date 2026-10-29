/**
 * Shared import target for the per-family shell subpaths
 * (`@linxin666/dsh-web-all/<family>`, one package.json exports key per family
 * subpath the aggregate still publishes, all pointing here). No family patch
 * row names a subpath any more: rows mount the real package, so this module
 * serves the two things a kept subpath is still for.
 *
 * 1. Compatibility: a profile written before the rows named their packages
 *    still records `@linxin666/dsh-web-all/<family>` as the row name, and
 *    that specifier has to keep resolving.
 * 2. Retirement registry: aggregate.yml's retiredPlugins section renders into
 *    ./retired-plugins.generated.ts. A stale row for a registered family
 *    carries the real package name in `config.plugin`, and this module skips
 *    the import for it, so a normal retirement stays a silent no-op instead of
 *    a degraded plugin on the health route. That list is empty today — every
 *    family it carried has since been removed outright — but the section, the
 *    generated module and the skip branch stay: they are what a future
 *    retirement needs, and the generated module is the only thing the branch
 *    reads.
 *
 * A family removed outright has neither: its exports key and its display
 * resources are gone with it, so a stale row naming it reaches the import,
 * fails there, and is recorded as a degraded import.
 *
 * This file MUST live under shells/: the client module scanner resolves a
 * row's module URL and walks up to the nearest package.json, and the marker
 * manifest beside this file (src/shells/package.json, copied to lib/shells/)
 * stops that walk before it reaches the package root — whose dsh.client face
 * belongs to the compat row alone. A second scanner source for the same
 * package is a hard reconcile error ("resolves from multiple active Loader
 * sources").
 */
export { apply, inject, Config } from '../shell.ts'
