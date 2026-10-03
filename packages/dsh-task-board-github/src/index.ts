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
// Type-only: pulls the host web server's Context merge (ctx.webServer) this
// half registers its setup routes on.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveTaskBoardHostFace } from './core/contract.ts'
import { createGitHubExtension } from './host/extension.ts'
import { probeWorkspaceRegistry } from './host/workspace-registry.ts'
import { resolveGitHubToken } from './host/credentials.ts'
import { makeGitHubSetupRoutes } from './host/routes.ts'
import { createGitHubSetup } from './host/setup.ts'
import { mountOnce } from './mount-once.ts'
import { PLUGIN_TOOL_SECTION_ORDERS, visibleToolText } from './tool-surface.ts'

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
const SECTION_ORDER = PLUGIN_TOOL_SECTION_ORDERS['task-board-github']

/** The nine agent-tool names this extension's announcement describes. */
const GITHUB_TOOL_NAMES = [
  'task_board_github_setup',
  'task_board_github_repositories',
  'task_board_github_list',
  'task_board_github_get',
  'task_board_github_refresh',
  'task_board_github_create_pr',
  'task_board_github_link_pr',
  'task_board_github_comment',
  'task_board_github_close_issue',
] as const

/**
 * Model-facing announcement: what the extension does, what it never does with
 * remote text, and the words that name it.
 */
export const GITHUB_GUIDANCE = '本机已安装 dsh-task-board-github 扩展（DSH Web GUI 任务看板的 GitHub Issues 提供方）：把带包含标签的 GitHub issue 同步为看板卡片，并把卡片的列变化写回 issue 上由本扩展管理的标签；另注册 task_board_github_* agent 工具（list/get/refresh/create_pr/link_pr/comment/close_issue），随看板总开关与本扩展开关一起收放。GitHub 凭据只在宿主进程从环境变量读取，绝不进入浏览器、设置卡或模型可见载荷；远端 issue 文本只作为卡片内容，绝不进入 promptPrefix、权限或工作区身份。用户提到「GitHub 任务 / GitHub issue / 同步 GitHub / 关联 PR / 创建 PR」时即指本扩展，请据此协作。'

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
 * Every field is volatile, which is what makes it editable at all: the Host's
 * settings surface serves forms for volatile fields only, and the browser
 * card, the setup tools and the Host routes all write through that surface.
 * The Loader commits an edit into the running fiber's references without
 * remounting the row, so {@link resolveProviderSettings} reads them at use
 * time and a repository or credential change reaches the next poll without a
 * restart.
 */
export interface Config {
  /** Master switch for the extension. */
  enabled?: Volatile<boolean>
  /** Whether this extension announces itself in every agent system prompt. */
  announceToAgent?: Volatile<boolean>
  /**
   * Credential reference the GitHub API token is resolved under — an
   * environment variable name, or the name a token was stored under in the
   * harness credential store. The value itself never reaches the browser or an
   * agent.
   */
  tokenEnv?: Volatile<string>
  /** Repositories configured for GitHub Issues synchronization. */
  repositories?: Volatile<GitHubRepoConfig[]>
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
  /** Login whose assigned issues are included too; `@me` means this host's account. */
  assignee?: string
  /** Whether issues assigned to nobody are included too. */
  includeUnassigned?: boolean
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
  assignee: z.string().default(''),
  includeUnassigned: z.boolean().default(false),
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
  tokenEnv: z.string().default(DEFAULT_TOKEN_ENV).volatile(),
  repositories: z.array(GitHubRepoConfigSchema).default([]).volatile(),
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
    tokenEnv: readConfigField(config?.tokenEnv, DEFAULT_TOKEN_ENV),
    repositories: readConfigField<GitHubRepoConfig[]>(config?.repositories, []),
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
  section(spec: { name: string; order: number; text: string | ((context: { scope?: unknown }) => string) }): () => void
}

/**
 * Resolve the optional system-prompt service without declaring it a required
 * inject: a deployment that serves none still gets the provider, just without
 * the announcement.
 * @param ctx - host context.
 * @returns the service, or undefined.
 */
/** The lookup face of the tool registry, when this deployment serves one. */
interface ToolLookupFace {
  get(name: string, scope?: unknown): unknown
}

/**
 * Resolve the optional tool registry's scoped lookup. The extension registers
 * its tools through the board, so the tools land in the same global layer this
 * reads; a deployment without the registry simply keeps the announcement.
 * @param ctx - the host plugin context.
 * @returns the lookup, or undefined when none is served.
 */
function resolveToolLookup(ctx: Context): ToolLookupFace | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const tools = get.call(ctx, 'tools') as ToolLookupFace | undefined
    return tools !== undefined && typeof tools.get === 'function' ? tools : undefined
  } catch {
    return undefined
  }
}

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
 *
 * Registration lives behind a cordis dependency scope (`ctx.inject`) rather
 * than a one-shot lookup: the Host loads plugin rows in an order this package
 * does not own, so the board's registration service may genuinely not exist yet
 * when this row activates. The scope mounts once the service is served and
 * unloads — releasing the provider, its tools and its published summary — when
 * the board withdraws it.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
function applyImpl(ctx: Context, config?: Config): void {
  /** Current settings, read live so every volatile edit is followed. */
  const settings = (): GitHubProviderSettings => resolveProviderSettings(config)

  /** The dependency-scoped fiber that owns the registration, while enabled. */
  let injection: ReturnType<Context['inject']> | undefined
  /** The dependency-scoped fiber that owns the setup routes, when a web server is served. */
  let routesInjection: ReturnType<Context['inject']> | undefined
  /** Whether the board currently holds this provider. */
  let providerLive = false
  /** Signature of the mounted registration; a change remounts it. */
  let mounted: string | undefined
  /** The credential the mounted client authenticates with. */
  let token: string | undefined
  let disposed = false
  let disposeSection: (() => void) | undefined
  let announceLive = false

  /** The configuration surface the settings card, the routes and the tools share. */
  const setup = createGitHubSetup({
    ctx,
    repositories: () => settings().repositories,
    tokenEnv: () => settings().tokenEnv,
    running: () => providerLive,
    // A credential write lands in the store, so the value this process already
    // read is stale: re-resolve and remount before the next request.
    reload: () => { requestSync() },
  })

  /** Drop the mounted registration; the next sync remounts it. */
  const teardownProvider = (): void => {
    const current = injection
    injection = undefined
    providerLive = false
    mounted = undefined
    if (current !== undefined) void current.dispose()
  }

  /**
   * Apply the live settings: register, remount or release the provider, and
   * keep the announcement in step with its switch.
   */
  const sync = async (): Promise<void> => {
    if (disposed) return
    const next = settings()
    const wantAnnounce = next.enabled && next.announceToAgent
    if (wantAnnounce !== announceLive) {
      announceLive = wantAnnounce
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
      if (wantAnnounce) {
        const systemPrompt = resolveSystemPrompt(ctx)
        if (systemPrompt !== undefined) {
          try {
            disposeSection = systemPrompt.section({
              name: 'plugin:task-board-github',
              order: SECTION_ORDER,
              // The announcement names the task_board_github_* tools, so it
              // renders only while at least one is reachable: a board whose
              // tool surface is off, or a restriction that withholds them, must
              // not leave guidance for tools this session cannot see.
              text: visibleToolText(resolveToolLookup(ctx), GITHUB_TOOL_NAMES, GITHUB_GUIDANCE),
            })
          } catch {
            // A refused section costs the announcement only.
          }
        }
      }
    }
    if (!next.enabled) {
      teardownProvider()
      return
    }
    // The credential is re-resolved on every sync: reading the store is cheap,
    // and a token rotated behind this process (the Models page, a hand-edited
    // store) must reach the next request instead of the copy read at activation.
    const resolved = await resolveGitHubToken(ctx, next.tokenEnv)
    if (disposed) return
    const desired = JSON.stringify({ tokenEnv: next.tokenEnv, token: resolved ?? null, repositories: next.repositories })
    if (desired === mounted) return
    teardownProvider()
    token = resolved
    mounted = desired
    // Cordis runs this callback once the board serves `taskBoard` — whether
    // that is already true when this row activates or becomes true later — and
    // disposes the scope (unregistering the provider, its tools and its
    // published summary) when the service is withdrawn or replaced.
    injection = ctx.inject(['taskBoard'], (scope: Context) => {
      scope.effect(() => {
        const face = resolveTaskBoardHostFace(scope)
        if (face === undefined) {
          // Unreachable while the dependency scope holds, and not a dead end:
          // cordis re-runs this effect when the implementation behind the name
          // changes.
          console.error('[dsh-task-board-github] the taskBoard service does not answer the registration contract')
          return () => {}
        }
        providerLive = true
        const dispose = face.registerExtension(createGitHubExtension({
          repositories: next.repositories.map(repository => ({ ...repository })),
          token,
          tokenEnv: next.tokenEnv,
          enabled: () => settings().enabled,
          workspaceRegistry: () => probeWorkspaceRegistry(ctx),
          setup,
        }))
        return () => { providerLive = false; dispose() }
      }, 'task-board-github: provider registration')
    })
  }

  /**
   * Serialize sync requests: a configuration write, a credential write and a
   * volatile commit can arrive together, and two overlapping syncs would both
   * mount (leaking one registration fiber).
   */
  let chain: Promise<void> = Promise.resolve()
  const requestSync = (): void => {
    chain = chain.then(() => sync()).catch(error => { console.error('[dsh-task-board-github] sync failed', error) })
  }

  // A settings edit of a volatile field is committed into the references this
  // fiber already holds, with no remount and no second call to apply.
  ctx.on('loader/volatile-update', () => { requestSync() })
  // A credential stored elsewhere — the settings card, a tool, the Models page
  // or a hand-edited store — reaches the next request without a row reload.
  ctx.on('credentials/reference-updated', () => { requestSync() })

  // The setup routes need a web server. A deployment without one keeps the
  // provider, its polling and its tools, and loses only the configuration API
  // the browser card and a remote caller speak to.
  routesInjection = ctx.inject(['webServer'], (scope: Context) => {
    scope.effect(() => {
      const disposers = makeGitHubSetupRoutes(setup).map(route => scope.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* route fiber already gone during shutdown */ }
        }
      }
    }, 'task-board-github: setup routes')
  })

  ctx.effect(() => {
    requestSync()
    return () => {
      disposed = true
      teardownProvider()
      const routes = routesInjection
      routesInjection = undefined
      if (routes !== undefined) void routes.dispose()
      try { disposeSection?.() } catch { /* best-effort */ }
      disposeSection = undefined
    }
  }, 'task-board-github: provider lifecycle')
}
