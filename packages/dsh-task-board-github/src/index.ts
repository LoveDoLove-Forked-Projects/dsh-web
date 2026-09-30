/**
 * Host half of the task-board GitHub provider extension.
 *
 * This package is an EXTERNAL PROVIDER EXTENSION for the task board
 * (`@linxin666/dsh-client-ui-task-board`): it owns the GitHub Issues
 * configuration and, from the migration stage on, the synchronization service
 * that feeds GitHub items into the board's provider contract. This stage
 * carries the package skeleton: the configuration schema with its documented
 * defaults, and the lifecycle seam the provider registration will fill.
 *
 * It deliberately imports no task-board internals. Cross-package collaboration
 * goes through the board's provider service (the contract owned by
 * packages/dsh-task-board), so the extension stays a standalone bundle that can
 * be built, published and loaded on its own.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mountOnce } from './mount-once.ts'

/**
 * npm identity shared by every install source of this package. The host
 * single-instance guard keys on it, so an aggregate install and a standalone
 * install of the same package do not double-register the provider.
 */
export const PACKAGE_NAME = '@linxin666/dsh-client-ui-task-board-github'

/** Default environment variable holding the GitHub API token. */
export const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN'

/** Draft policies a pull request this provider opens may use. */
export const DRAFT_PR_POLICIES = ['draft', 'ready'] as const

/** Draft policy for pull requests this provider opens. */
export type DraftPrPolicy = (typeof DRAFT_PR_POLICIES)[number]

/** GitHub labels one repository maps onto the board columns. */
export interface GitHubStateLabels {
  /** Label of items waiting in the backlog. */
  backlog: string
  /** Label of items ready to pick up. */
  todo: string
  /** Label of items currently being worked on. */
  running: string
  /** Label of finished items. */
  done: string
  /** Label of failed items. */
  failed: string
}

/** One GitHub repository the extension synchronizes. */
export interface GitHubRepoConfig {
  /** Repository owner (user or organization). */
  owner: string
  /** Repository name. */
  repository: string
  /** Issue label that opts an issue into the board. */
  inclusionLabel: string
  /** Prefix of the labels this extension manages itself. */
  managedLabelPrefix: string
  /** GitHub labels mapped onto the board columns. */
  stateLabels: GitHubStateLabels
  /** Label marking the pull-request phase of an item. */
  prPhaseLabel: string
  /** Poll interval in milliseconds. */
  pollingIntervalMs: number
  /** Whether the extension may open pull requests. */
  prCreationEnabled: boolean
  /** Whether opened pull requests start as drafts. */
  draftPrPolicy: DraftPrPolicy
  /** Whether merging a pull request closes its issue. */
  closeIssueOnMerge: boolean
  /** Base branch pull requests target. */
  baseBranch: string
}

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * The fields the browser card edits are marked volatile: the Loader commits an
 * edit into the running fiber's references without remounting the row, so
 * {@link resolveProviderSettings} reads them at use time. `tokenEnv` and
 * `repositories` stay ordinary fields — editing them reloads the row, which
 * re-runs the activation with the new synchronization targets.
 */
export interface Config {
  /** Master switch for the extension. */
  enabled?: Volatile<boolean>
  /**
   * Whether this extension announces itself in every agent system prompt. Off
   * by default so prompts stay clean; the settings card exposes the switch and
   * the announcement lands with the provider registration.
   */
  announceToAgent?: Volatile<boolean>
  /** Environment variable holding the GitHub API token; never exposed to the browser or an agent. */
  tokenEnv?: string
  /** Repositories configured for GitHub Issues synchronization. */
  repositories?: GitHubRepoConfig[]
}

/**
 * Profile-patch shape of {@link Config}: what the Host validates the row's
 * config against, before the schema turns volatile fields into live references
 * and applies defaults. Declared separately because the two sides no longer
 * share one shape, so the schema is annotated `z<ConfigInput, Config>`.
 */
export interface ConfigInput {
  /** Master switch for the extension. */
  enabled?: boolean
  /** Announce the extension in agent system prompts. */
  announceToAgent?: boolean
  /** Environment variable holding the GitHub API token. */
  tokenEnv?: string
  /** Repositories configured for GitHub Issues synchronization. */
  repositories?: GitHubRepoConfigInput[]
}

/**
 * One repository as a profile patch declares it: only `owner` and
 * `repository` are required, every other field falls back to its schema
 * default.
 */
export interface GitHubRepoConfigInput {
  /** Repository owner (user or organization). */
  owner: string
  /** Repository name. */
  repository: string
  /** Issue label that opts an issue into the board. */
  inclusionLabel?: string
  /** Prefix of the labels this extension manages itself. */
  managedLabelPrefix?: string
  /** GitHub labels mapped onto the board columns. */
  stateLabels?: Partial<GitHubStateLabels>
  /** Label marking the pull-request phase of an item. */
  prPhaseLabel?: string
  /** Poll interval in milliseconds. */
  pollingIntervalMs?: number
  /** Whether the extension may open pull requests. */
  prCreationEnabled?: boolean
  /** Whether opened pull requests start as drafts. */
  draftPrPolicy?: DraftPrPolicy
  /** Whether merging a pull request closes its issue. */
  closeIssueOnMerge?: boolean
  /** Base branch pull requests target. */
  baseBranch?: string
}

/** One configured repository, as the profile patch declares it. */
const GitHubRepoConfigSchema = z.object({
  owner: z.string(),
  repository: z.string(),
  inclusionLabel: z.string().default('dsh'),
  managedLabelPrefix: z.string().default('dsh:'),
  stateLabels: z.object({
    backlog: z.string().default('dsh:state:backlog'),
    todo: z.string().default('dsh:state:todo'),
    running: z.string().default('dsh:state:running'),
    done: z.string().default('dsh:state:done'),
    failed: z.string().default('dsh:state:failed'),
  }),
  prPhaseLabel: z.string().default('dsh:phase:pr'),
  pollingIntervalMs: z.number().default(300_000),
  prCreationEnabled: z.boolean().default(false),
  draftPrPolicy: z.union(DRAFT_PR_POLICIES).default('draft'),
  closeIssueOnMerge: z.boolean().default(true),
  baseBranch: z.string().default('main'),
})

export const Config: z<ConfigInput, Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(false).volatile(),
  tokenEnv: z.string().default(DEFAULT_TOKEN_ENV),
  repositories: z.array(GitHubRepoConfigSchema).default([]),
})

/** The effective settings of one mount, with schema defaults applied. */
export interface GitHubProviderSettings {
  /** Master switch. */
  enabled: boolean
  /** Whether the extension announces itself in agent system prompts. */
  announceToAgent: boolean
  /** Environment variable holding the GitHub API token. */
  tokenEnv: string
  /** Repositories to synchronize. */
  repositories: readonly GitHubRepoConfig[]
}

/**
 * Read one config field's current value.
 *
 * The Loader hands schema-volatile fields as stable references it commits in
 * place, so a live value must be read at use time rather than captured when the
 * plugin activates; a plain value (a programmatic mount, or a field the schema
 * does not mark volatile) is returned as it stands.
 * @param field - the config field as the Loader handed it.
 * @param fallback - value to use when the field is absent.
 * @returns the effective field value.
 */
export function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as Volatile<T>).get() as T
  }
  return field as T
}

/**
 * Resolve the effective settings of one mount from its config.
 * @param config - the row's config as the Host handed it.
 * @returns the settings a provider registration would consume.
 */
export function resolveProviderSettings(config?: Config): GitHubProviderSettings {
  return {
    enabled: readConfigField(config?.enabled, true),
    announceToAgent: readConfigField(config?.announceToAgent, false),
    tokenEnv: config?.tokenEnv ?? DEFAULT_TOKEN_ENV,
    repositories: config?.repositories ?? [],
  }
}

export const apply = mountOnce(PACKAGE_NAME, applyImpl)

/**
 * Activate the extension's host half.
 *
 * This stage resolves the row's configuration and holds the lifecycle seam; it
 * registers nothing yet. A disabled row takes no lifecycle at all, so turning
 * the switch off in the settings card releases the provider without a remount.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function applyImpl(ctx: Context, config?: Config): void {
  /** Current settings, read live so a volatile switch edit is followed. */
  const settings = (): GitHubProviderSettings => resolveProviderSettings(config)
  if (!settings().enabled) return
  // TODO(M3): register the GitHub Issues provider through the task board's
  // external-provider contract and release it from this effect's disposer.
  // The board owns the registration surface; this package must not import
  // task-board internals.
  ctx.effect(() => () => {}, 'task-board-github: provider lifecycle placeholder')
}
