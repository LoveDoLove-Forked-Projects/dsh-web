/**
 * Host half of the task-board GitHub provider extension.
 *
 * This package is an EXTERNAL PROVIDER EXTENSION for the task board
 * (`@linxin666/dsh-client-ui-task-board`). It owns the GitHub Issues
 * configuration and the synchronization service, and it reaches the board
 * exclusively through the board's provider service: it imports no board
 * module, and every capability it uses is the same-shape contract restated in
 * `src/core/contract.ts`.
 *
 * The master switch is volatile and read at use time: turning it off in the
 * settings card releases the provider (polling stops, the event subscriptions
 * go, the tools unregister and the published summary clears) without a remount
 * or a restart.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  resolveTaskBoardHostFace,
  type TaskBoardHostFace,
} from './core/contract.ts'
import { createGitHubExtension } from './host/extension.ts'
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

/** Order of this extension's announcement section, just after the board's. */
const SECTION_ORDER = 210

/**
 * Model-facing announcement: what the extension does, what it never does with
 * remote text, and the words that name it.
 */
export const GITHUB_GUIDANCE = '本机已安装 dsh-task-board-github 扩展（DSH Web GUI 任务看板的 GitHub Issues 提供方）：把带包含标签的 GitHub issue 同步为看板卡片，并把卡片的列变化写回 issue 上由本扩展管理的标签；另注册 task_board_github_* agent 工具（list/get/refresh/create_pr/link_pr），随看板总开关与本扩展开关一起收放。GitHub 凭据只在宿主进程从环境变量读取，绝不进入浏览器、设置卡或模型可见载荷；远端 issue 文本只作为卡片内容，绝不进入 promptPrefix、权限或工作区身份。用户提到「GitHub 任务 / GitHub issue / 同步 GitHub / 关联 PR / 创建 PR」时即指本扩展，请据此协作。'

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
  /** Whether this extension announces itself in every agent system prompt. */
  announceToAgent?: Volatile<boolean>
  /** Environment variable holding the GitHub API token; never exposed to the browser or an agent. */
  tokenEnv?: string
  /** Repositories configured for GitHub Issues synchronization. */
  repositories?: GitHubRepoConfig[]
}

/**
 * Profile-patch shape of {@link Config}: what the Host validates the row's
 * config against, before the schema turns volatile fields into live references
 * and applies defaults.
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

/** Schema default of the announcement switch, re-read for hand-built contexts. */
export const DEFAULT_ANNOUNCE_TO_AGENT = false

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
 * @returns the settings the provider registration consumes.
 */
export function resolveProviderSettings(config?: Config): GitHubProviderSettings {
  return {
    enabled: readConfigField(config?.enabled, true),
    announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE_TO_AGENT),
    tokenEnv: config?.tokenEnv ?? DEFAULT_TOKEN_ENV,
    repositories: config?.repositories ?? [],
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only. Spelled here because the
     * Loader package is not a dependency of this plugin, with the Loader's own
     * shape so the two declarations merge when a Host program carries both.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** The slice of the system-prompt service this extension announces through. */
interface SystemPromptFace {
  section(spec: { name: string; order: number; text: string }): () => void
}

/**
 * Resolve the optional system-prompt service without declaring it a required
 * inject: a deployment that serves none still gets the provider, just without
 * the announcement.
 * @param ctx - host context.
 * @returns the service, or undefined.
 */
function resolveSystemPrompt(ctx: Context): SystemPromptFace | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const face = get.call(ctx, 'systemPrompt') as SystemPromptFace | undefined
    return face !== undefined && typeof (face as { section?: unknown }).section === 'function' ? face : undefined
  } catch {
    return undefined
  }
}

export const apply = mountOnce(PACKAGE_NAME, applyImpl)

/**
 * Activate the extension's host half.
 *
 * The provider is admitted through the board's own registration service, so it
 * follows the board's master switch as well as this extension's: the board
 * starts it only while both are on. The two fields the settings card edits are
 * volatile, so `sync` reads them at use time and follows
 * `loader/volatile-update`; a switch flip re-registers (or releases) the
 * provider immediately, without a remount.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function applyImpl(ctx: Context, config?: Config): void {
  /** Current settings, read live so a volatile switch edit is followed. */
  const settings = (): GitHubProviderSettings => resolveProviderSettings(config)

  let disposeRegistration: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let appliedEnabled: boolean | undefined
  let appliedAnnounce: boolean | undefined
  let warnedMissingBoard = false

  const releaseProvider = (): void => {
    const dispose = disposeRegistration
    disposeRegistration = undefined
    try { dispose?.() } catch { /* the board owns its own teardown */ }
  }

  const registerProvider = (face: TaskBoardHostFace): void => {
    disposeRegistration = face.registerExtension(createGitHubExtension({
      repositories: config?.repositories,
      tokenEnv: config?.tokenEnv,
      enabled: () => settings().enabled,
    }))
  }

  const sync = (): void => {
    const next = settings()
    if (appliedEnabled !== next.enabled) {
      appliedEnabled = next.enabled
      releaseProvider()
      if (next.enabled) {
        const face = resolveTaskBoardHostFace(ctx)
        if (face === undefined) {
          if (!warnedMissingBoard) {
            warnedMissingBoard = true
            console.warn('[dsh-task-board-github] the task board provider service is not served; the GitHub provider stays idle until the board is installed')
          }
        } else {
          registerProvider(face)
        }
      }
    }
    if (appliedAnnounce !== next.announceToAgent) {
      appliedAnnounce = next.announceToAgent
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
      if (next.enabled && next.announceToAgent) {
        const systemPrompt = resolveSystemPrompt(ctx)
        if (systemPrompt !== undefined) {
          try {
            disposeSection = systemPrompt.section({
              name: 'plugin:task-board-github',
              order: SECTION_ORDER,
              text: GITHUB_GUIDANCE,
            })
          } catch {
            // A refused section costs the announcement only.
          }
        }
      }
    }
  }

  // A settings edit of a volatile field is committed into the references this
  // fiber already holds, with no remount and no second call to apply.
  ctx.on('loader/volatile-update', () => { sync() })

  ctx.effect(() => {
    sync()
    return () => {
      releaseProvider()
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
    }
  }, 'task-board-github: provider lifecycle')
}
