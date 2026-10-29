/**
 * The provider's hub synchronization: registration, heartbeat, claiming, leases
 * and write-back.
 *
 * The division of authority runs through every method here. The hub decides
 * which issues exist, who owns them and what collaboration status they carry;
 * this Host decides whether it may take one, how it runs it locally and what the
 * run produced. A claim is the only moment the two meet: the hub hands over a
 * lease and an attempt id, this Host materializes the issue as a board card and
 * reports back when that card's execution settles.
 *
 * Reconnection is the interesting path, so it is written as one: the attempt
 * credentials live on the card's own payload, and a re-claim presents them. A
 * hub that recognizes them re-establishes the lease and creates nothing new, and
 * this Host in turn never creates a second card for an issue it already mirrors
 * and never starts a second execution for an attempt it already ran.
 *
 * @module dsh-task-board-team/host/service
 */
import {
  type HubAgentDefinition,
  type HubComment,
  type HubIssue,
  type HubIssueStatus,
  HOST_CLIENT_VERSION,
  LEASE_RENEW_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SWEEP_INTERVAL_MS,
  readServerFrame,
  type HubServerFrame,
} from '../core/hub-protocol.ts'
import type { TaskBoardExtensionHost, TaskBoardCapabilities, TaskBoardLinkedTask } from '../core/contract.ts'
import {
  TEAM_EXTENSION_ID,
  findLinkedTask,
  readTaskIssueLink,
  toPayload,
  type TeamIssueLink,
} from '../core/identity.ts'
import { buildMirrorDraft, type MirrorAgent } from '../core/mirror.ts'
import { buildSettleRequest } from '../core/settlement.ts'
import type { TaskRecord } from '../core/task-record.ts'
import type { HostTimerFace } from '../core/timers.ts'
import type { BoundAgent, TeamAgentBinding } from './bindings.ts'
import { HubError, type HubClient } from './hub-client.ts'
import { QuestionRouter, type PendingQuestionView } from './questions.ts'
import type { SocketHandlers, SocketLike } from './channel.ts'

/** Live settings of one mount, read at use time. */
export interface TeamRuntimeSettings {
  /** Whether this extension is switched on. */
  enabled: boolean
  /** Hostname this Host registers under. */
  hostname: string
  /** Configured member bindings. */
  bindings: readonly TeamAgentBinding[]
  /** Optional local fallback wait for a claimed question, in minutes; 0 means none. */
  questionWaitMinutes?: number
}

/** One comment, as the browser renders it. */
export interface TeamCommentView {
  id: string
  author: string
  content: string
  createdAt: number
}

/** One activity entry, as the browser renders it. */
export interface TeamActivityView {
  id: string
  type: string
  text: string
  createdAt: number
}

/** The collaboration half of one mirrored card. */
export interface TeamCardView {
  issueId: string
  issueNumber?: number
  hubStatus?: HubIssueStatus
  assignee?: string
  reviewer?: string
  /** Member id behind `assignee`, when the hub named one. */
  assigneeMemberId?: string
  /** Member id behind `reviewer`, when the hub named one. */
  reviewerMemberId?: string
  agentName?: string
  comments: TeamCommentView[]
  activity: TeamActivityView[]
  lastError?: string
}

/** How the row's connection to the hub currently stands. */
export type TeamConnectionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error'

/** The summary this extension publishes into the board snapshot. */
export interface TeamExtensionSummary {
  connection: {
    state: TeamConnectionState
    hostId?: string
    lastHeartbeatAt?: number
    reconnects: number
    lastError?: string
  }
  capabilities: TaskBoardCapabilities
  agents: Array<{ memberId: string; name: string; preset?: string; hubAgentId?: string }>
  problems: string[]
  /**
   * Whether this board pins a draft preset, model and effort when it creates a
   * card.
   *
   * `unknown` until the first mirror card proves it either way: the verdict comes
   * from reading the created card back, because a board revision without the
   * draft targets drops them silently.
   */
  presetPin: 'unknown' | 'supported' | 'missing'
  cards: Record<string, TeamCardView>
  pendingQuestions: PendingQuestionView[]
  /**
   * Non-secret configuration, added by the mounting row rather than by the
   * service: the settings block renders the configured hub, team and bindings
   * from the same document it reads everything else from.
   */
  configuration?: {
    hubUrl?: string
    teamId?: string
    hostname?: string
    tokenConfigured?: boolean
    /** Optional local fallback wait for a claimed question, in minutes; 0 means none. */
    questionWaitMinutes?: number
  }
}

/** The problem line published when the board serves no draft preset. */
export const DRAFT_PIN_PROBLEM = 'this board revision cannot pin an agent preset, model or reasoning effort on a new card, so a claimed issue becomes a mirror card that is left for a human to start'

/** Longest comment or activity text one summary carries. */
const VIEW_TEXT_LIMIT = 2_000
/** Most comments and activity entries one summary carries per card. */
const VIEW_ENTRY_LIMIT = 20

export interface TeamSyncServiceOptions {
  /** The board's capability face. */
  host: TaskBoardExtensionHost
  /** Hub REST client. */
  hub: HubClient
  /** Live settings. */
  settings: () => TeamRuntimeSettings
  /** Resolve the bound members out of the dsh-agents ledger. */
  resolveAgents: () => Promise<{ agents: BoundAgent[]; problems: string[] }>
  /** Open the team channel; undefined means this deployment cannot. */
  connect: (sinceSeq: number, handlers: SocketHandlers) => Promise<SocketLike | undefined>
  /** Which optional capabilities the board really serves. */
  capabilities: TaskBoardCapabilities
  /** Ask the board to run one card; absent means this Host cannot start executions. */
  requestRun?: (taskId: string) => void
  timers: HostTimerFace
  now: () => number
  uuid: () => string
  log?: (message: string, detail?: unknown) => void
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= VIEW_TEXT_LIMIT ? trimmed : trimmed.slice(0, VIEW_TEXT_LIMIT - 3) + '...'
}

/** The synchronization service of one mounted extension. */
export class TeamSyncService {
  readonly #options: TeamSyncServiceOptions
  readonly #questions: QuestionRouter
  readonly #leases = new Map<string, () => void>()
  readonly #cards = new Map<string, TeamCardView>()
  /** Hub agent records by their hub id, learned at registration. */
  readonly #hubAgents = new Map<string, BoundAgent>()
  #agents: BoundAgent[] = []
  #problems: string[] = []
  #hostId: string | undefined
  #seq = 0
  #socket: SocketLike | undefined
  #stopHeartbeat: (() => void) | undefined
  #stopReconnect: (() => void) | undefined
  #started = false
  #connection: TeamConnectionState = 'idle'
  #lastError: string | undefined
  #lastHeartbeatAt: number | undefined
  #reconnects = 0
  #reconnectAttempt = 0
  #starting: Promise<void> | undefined
  #presetPin: 'unknown' | 'supported' | 'missing' = 'unknown'
  /** Instant of the last sweep, so a burst of events coalesces into one pass. */
  #lastSweepAt: number | undefined
  /** A sweep scheduled for the next cadence boundary, while one is pending. */
  #pendingSweep: (() => void) | undefined
  /** Issues with a claim in flight: one claim per issue at a time. */
  readonly #claiming = new Set<string>()

  constructor(options: TeamSyncServiceOptions) {
    this.#options = options
    this.#questions = new QuestionRouter({
      hub: options.hub,
      host: options.host,
      linked: () => this.#linked(),
      timers: options.timers,
      now: options.now,
      uuid: options.uuid,
      onChange: () => { this.#publish() },
      fallbackWaitMs: () => {
        const minutes = options.settings().questionWaitMinutes ?? 0
        return minutes > 0 ? minutes * 60_000 : undefined
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    })
  }

  /** Republish the summary, e.g. after a configuration write changed what it shows. */
  publishNow(): void {
    this.#publish()
  }

  /** The question router this service routes the Host waterfall through. */
  get questions(): QuestionRouter {
    return this.#questions
  }

  /** Start registration, heartbeat, the channel and the first claim sweep. */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    this.#starting = this.#bootstrap()
    await this.#starting
  }

  /**
   * Resolve once this mount finished registering, or immediately when it has not
   * started at all.
   *
   * A sweep requested before registration completes must wait for the host id
   * instead of silently claiming nothing, which is what a caller racing the
   * bootstrap would otherwise get.
   * @returns a promise resolved when the bootstrap settles.
   */
  async whenStarted(): Promise<void> {
    await this.#starting
  }

  /** Release every timer, the socket and every pending question claim. */
  stop(): void {
    this.#started = false
    this.#stopHeartbeat?.()
    this.#stopHeartbeat = undefined
    this.#stopReconnect?.()
    this.#stopReconnect = undefined
    this.#pendingSweep?.()
    this.#pendingSweep = undefined
    this.#socket?.close()
    this.#socket = undefined
    for (const cancel of this.#leases.values()) cancel()
    this.#leases.clear()
    this.#questions.dispose()
    this.#connection = 'idle'
  }

  /** The summary the browser renders, built fresh from the live state. */
  summary(): TeamExtensionSummary {
    const cards: Record<string, TeamCardView> = {}
    for (const [taskId, view] of this.#cards) cards[taskId] = { ...view }
    for (const entry of this.#linked()) {
      const link = readTaskIssueLink(entry.task)
      if (link === undefined) continue
      const existing = cards[entry.task.id]
      cards[entry.task.id] = {
        issueId: link.issueId,
        ...(link.issueNumber === undefined ? {} : { issueNumber: link.issueNumber }),
        ...(link.hubStatus === undefined ? {} : { hubStatus: link.hubStatus }),
        ...(link.assignee === undefined ? {} : { assignee: link.assignee }),
        ...(link.reviewer === undefined ? {} : { reviewer: link.reviewer }),
        comments: existing?.comments ?? [],
        activity: existing?.activity ?? [],
        ...(link.lastError === undefined ? {} : { lastError: link.lastError }),
        ...(existing?.agentName === undefined ? {} : { agentName: existing.agentName }),
      }
    }
    const agents = this.#agents.map(agent => {
      const hubAgentId = this.#hubAgentIdOf(agent.memberId)
      return {
        memberId: agent.memberId,
        name: agent.name,
        ...(agent.preset === undefined ? {} : { preset: agent.preset }),
        ...(hubAgentId === undefined ? {} : { hubAgentId }),
      }
    })
    return {
      connection: {
        state: this.#connection,
        ...(this.#hostId === undefined ? {} : { hostId: this.#hostId }),
        ...(this.#lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: this.#lastHeartbeatAt }),
        reconnects: this.#reconnects,
        ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      },
      capabilities: this.#options.capabilities,
      agents,
      problems: [...this.#problems],
      presetPin: this.#presetPin,
      cards,
      pendingQuestions: [...this.#questions.pending()],
    }
  }

  /**
   * Report one settled execution back to the hub.
   * @param event - the board's settlement notification.
   */
  async handleExecutionSettled(event: {
    taskId: string
    executionId: string
    outcome: 'succeeded' | 'failed' | 'cancelled'
    error?: string
  }): Promise<void> {
    const task = this.#options.host.tasks.get(event.taskId)
    if (task === undefined) return
    const link = readTaskIssueLink(task)
    if (link === undefined) return
    this.#releaseLease(task.id)
    const body = buildSettleRequest({
      task,
      executionId: event.executionId,
      outcome: event.outcome,
      ...(event.error === undefined ? {} : { error: event.error }),
      ...(link.attemptId === undefined ? {} : { attemptId: link.attemptId }),
    })
    try {
      const settled = await this.#options.hub.settle(link.issueId, body)
      this.#writeLink(task.id, { hubStatus: readStatus(settled.status) })
    } catch (error) {
      this.#recordError(task.id, error)
    }
    this.#publish()
  }

  /**
   * Claim every issue the hub offers this Host, for the agents bound to it.
   * @returns how many issues this pass turned into a new card.
   */
  async sweep(): Promise<number> {
    if (!this.#started) return 0
    await this.whenStarted()
    return await this.#runSweep()
  }

  /**
   * Ask for a sweep, coalesced to at most one pass per cadence window.
   *
   * A burst of channel events (a reviewer rejecting, a status moving, an issue
   * appearing) asks for the same work, and the hub counts Host requests per
   * minute (protocol amendment A4 point 6), so the asks collapse into one pass:
   * the current window's pass or the single pass scheduled at its boundary.
   */
  requestSweep(): void {
    if (!this.#started) return
    if (this.#pendingSweep !== undefined) return
    const now = this.#options.now()
    const last = this.#lastSweepAt
    if (last === undefined || now - last >= SWEEP_INTERVAL_MS) {
      void this.#runSweep()
      return
    }
    this.#pendingSweep = this.#options.timers.timeout(() => {
      this.#pendingSweep = undefined
      void this.#runSweep()
    }, SWEEP_INTERVAL_MS - (now - last))
  }

  /**
   * One claim sweep over what the hub currently offers this Host.
   * @returns how many issues this pass turned into a new card.
   */
  async #runSweep(): Promise<number> {
    if (this.#hostId === undefined) return 0
    this.#lastSweepAt = this.#options.now()
    let issues: readonly HubIssue[]
    try {
      issues = await this.#options.hub.listClaimableIssues(this.#hostId)
    } catch (error) {
      this.#lastError = describe(error)
      this.#publish()
      return 0
    }
    let claimed = 0
    for (const issue of issues) {
      // Only an agent bound to THIS machine may be executed here. The hub's own
      // filter is the first gate; this is the second, and it is the one that
      // keeps a wrongly listed issue from being run on the wrong machine.
      const agent = this.#agentFor(issue)
      if (agent === undefined) continue
      try {
        if (await this.#claimIssue(issue, agent)) claimed += 1
      } catch (error) {
        this.#lastError = describe(error)
        this.#options.log?.('claim failed for ' + issue.id, error)
      }
    }
    this.#publish()
    return claimed
  }

  /** The agents whose hub records were synchronized at registration. */
  boundAgents(): readonly BoundAgent[] {
    return this.#agents
  }

  async #bootstrap(): Promise<void> {
    const resolved = await this.#options.resolveAgents()
    // A member whose definition pins no preset is not registered (protocol
    // amendment A4 point 1): running it would silently fall back to the
    // deployment default, which is exactly what this provider must not do.
    const runnable = resolved.agents.filter(agent => agent.preset !== undefined && agent.preset !== '')
    const skipped = resolved.agents
      .filter(agent => agent.preset === undefined || agent.preset === '')
      .map(agent => agent.name + ' is not registered: its dsh-agents definition pins no agent preset, so this Host '
        + 'would have to run it under the deployment default')
    this.#agents = runnable
    this.#problems = [...resolved.problems, ...skipped]
    if (this.#agents.length === 0) {
      this.#problems = [...this.#problems, 'no dsh-agents member is bound to this Host, so no issue is claimed']
      this.#publish()
      return
    }
    await this.#register()
    if (this.#hostId === undefined) {
      this.#publish()
      return
    }
    this.#startHeartbeat()
    await this.#openChannel()
    await this.#runSweep()
  }

  async #register(): Promise<void> {
    this.#connection = 'connecting'
    const definitions: HubAgentDefinition[] = this.#agents.map(agent => ({
      name: agent.name,
      preset_id: agent.preset ?? '',
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.reasoningEffort === undefined ? {} : { reasoning_effort: agent.reasoningEffort }),
    }))
    try {
      const registered = await this.#options.hub.register({
        hostname: this.#options.settings().hostname,
        client_version: HOST_CLIENT_VERSION,
        agents: definitions,
      })
      this.#hostId = registered.host_id
      this.#connection = 'online'
      this.#lastError = undefined
      this.#hubAgents.clear()
      for (const record of readAgentRecords(registered)) {
        const local = this.#agents.find(agent => agent.name === record.name)
        if (local !== undefined) this.#hubAgents.set(record.id, local)
      }
    } catch (error) {
      this.#hostId = undefined
      this.#connection = 'error'
      this.#lastError = describe(error)
      this.#options.log?.('host registration failed', error)
    }
    this.#publish()
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat?.()
    const beat = (): void => {
      const hostId = this.#hostId
      if (hostId === undefined) return
      void this.#options.hub.heartbeat(hostId).then(() => {
        this.#lastHeartbeatAt = this.#options.now()
        if (this.#connection === 'reconnecting') this.#connection = 'online'
        this.#publish()
      }).catch((error: unknown) => {
        this.#lastError = describe(error)
        this.#options.log?.('heartbeat failed', error)
        this.#publish()
      })
    }
    this.#stopHeartbeat = this.#options.timers.interval(beat, HEARTBEAT_INTERVAL_MS)
    beat()
  }

  async #openChannel(): Promise<void> {
    this.#stopReconnect?.()
    this.#stopReconnect = undefined
    let socket: SocketLike | undefined
    try {
      socket = await this.#options.connect(this.#seq, {
        message: data => { this.#onFrame(data) },
        closed: reason => { this.#onClosed(reason) },
      })
    } catch (error) {
      this.#options.log?.('team channel could not open', error)
      socket = undefined
    }
    if (socket === undefined) {
      this.#lastError = 'the team channel is unavailable; reconnecting'
      this.#scheduleReconnect()
      this.#publish()
      return
    }
    this.#socket = socket
    this.#connection = 'online'
    this.#reconnectAttempt = 0
    this.#publish()
  }

  #scheduleReconnect(): void {
    this.#stopReconnect?.()
    this.#connection = 'reconnecting'
    this.#reconnects += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#reconnectAttempt, RECONNECT_MAX_MS)
    this.#reconnectAttempt += 1
    this.#stopReconnect = this.#options.timers.timeout(() => {
      this.#stopReconnect = undefined
      // Re-register first: a hub that restarted has forgotten this Host, and a
      // channel opened before registration would push events for an unknown host.
      void this.#register().then(async () => {
        await this.#openChannel()
        await this.#runSweep()
      }).catch((error: unknown) => {
        this.#options.log?.('reconnect failed', error)
        this.#scheduleReconnect()
      })
    }, delay)
  }

  #onClosed(reason?: string): void {
    if (!this.#started) return
    this.#socket = undefined
    if (reason !== undefined && reason !== '') this.#lastError = reason
    this.#publish()
    this.#scheduleReconnect()
  }

  #onFrame(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const frame = readServerFrame(parsed)
    if (frame === undefined) return
    if (frame.t === 'pong') return
    if (frame.t === 'resync_required') {
      // The channel could not replay what this Host missed, so the only honest
      // recovery is a fresh claim sweep: it re-establishes every issue the hub
      // still offers and leaves the rest on the hub.
      this.#seq = 0
      this.requestSweep()
      return
    }
    this.#onEvent(frame)
  }

  #onEvent(frame: Extract<HubServerFrame, { t: 'event' }>): void {
    // Sequence numbers only move forward; a replayed frame already applied is
    // dropped instead of being applied twice.
    if (frame.seq <= this.#seq && this.#seq !== 0) return
    this.#seq = frame.seq
    const payload = frame.payload
    switch (frame.event) {
      case 'question.answered':
        this.#questions.answered(payload)
        return
      case 'question.expired':
        this.#questions.expired(payload)
        return
      case 'question.withdrawn':
        this.#questions.withdrawn(payload)
        return
      case 'comment.created':
        this.#recordComment(payload)
        return
      case 'comment.mentioned':
        void this.#deliverMention(payload)
        return
      case 'issue.rework':
        void this.#rework(payload)
        return
      case 'issue.status_changed':
        this.#recordStatus(payload)
        return
      case 'issue.created':
      case 'issue.updated':
        this.requestSweep()
        return
      default:
        return
    }
  }

  /**
   * Claim one issue for one bound agent.
   * @returns whether this call created a card.
   */
  async #claimIssue(issue: HubIssue, agent: BoundAgent): Promise<boolean> {
    // One claim per issue at a time (protocol amendment A4 point 5): a sweep and
    // an event for the same issue would otherwise race two attempts.
    if (this.#claiming.has(issue.id)) return false
    this.#claiming.add(issue.id)
    try {
      return await this.#claimIssueExclusively(issue, agent)
    } finally {
      this.#claiming.delete(issue.id)
    }
  }

  async #claimIssueExclusively(issue: HubIssue, agent: BoundAgent): Promise<boolean> {
    const existing = findLinkedTask(this.#linked(), issue.id)
    const previous = existing === undefined ? undefined : readTaskIssueLink(existing)
    const credentials: { execution_attempt_id?: string; lease_token?: string } = {}
    // A hub answers `null` for an attempt it does not hold, and `undefined` is
    // what an older response body omits: both mean "no attempt yet".
    const heldAttempt = issue.execution_attempt_id ?? undefined
    if (previous?.attemptId !== undefined && previous.leaseToken !== undefined
      && (heldAttempt === undefined || heldAttempt === previous.attemptId)) {
      credentials.execution_attempt_id = previous.attemptId
      credentials.lease_token = previous.leaseToken
    }
    const claim = await this.#options.hub.claim(issue.id, credentials)
    const rework = typeof issue.rework_instructions === 'string' ? issue.rework_instructions.trim() : ''

    if (existing !== undefined) {
      // A hub that recognizes the attempt re-establishes the same lease. This
      // Host mirrors the credentials and starts NOTHING on its own: a second
      // execution for one attempt is exactly the duplicate this path prevents.
      // A pending rework IS the one thing that has to run, and only after the
      // claim above succeeded.
      this.#writeLink(existing.id, {
        attemptId: claim.execution_attempt_id,
        leaseToken: claim.lease_token,
        leaseExpiresAt: claim.lease_expires_at,
        hubStatus: 'running',
      })
      this.#ensureLease(existing, issue.id, claim.lease_token)
      if (rework !== '') this.#applyRework(existing.id, rework)
      return false
    }

    const mirror: MirrorAgent = {
      agentId: this.#hubAgentIdOf(agent.memberId) ?? agent.memberId,
      memberId: agent.memberId,
      name: agent.name,
      ...(agent.preset === undefined ? {} : { preset: agent.preset }),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
      ...(agent.workspaceId === undefined ? {} : { workspaceId: agent.workspaceId }),
    }
    const draft = buildMirrorDraft(issue, mirror)
    const payload = toPayload({
      issueId: issue.id,
      issueNumber: issue.issue_number,
      attemptId: claim.execution_attempt_id,
      leaseToken: claim.lease_token,
      leaseExpiresAt: claim.lease_expires_at,
      agentId: mirror.agentId,
      agentMemberId: agent.memberId,
      ...(agent.preset === undefined ? {} : { preset: agent.preset }),
      hubStatus: 'running',
    })
    let task: TaskRecord
    try {
      task = this.#options.host.tasks.create(draft, { payload })
    } catch (error) {
      this.#options.log?.('mirror card refused for ' + issue.id, error)
      this.#lastError = describe(error)
      return false
    }
    this.#cards.set(task.id, {
      issueId: issue.id,
      issueNumber: issue.issue_number,
      hubStatus: 'running',
      agentName: agent.name,
      comments: [],
      activity: [],
    })
    this.#ensureLease(task, issue.id, claim.lease_token)
    // The card is read back before anything runs: a board revision that cannot
    // pin the draft targets drops them silently, and a card that fell back to the
    // deployment's default preset must NOT be started as if it were the member's
    // own run. Such a card is left for a human, visibly.
    if (!this.#verifyDraftPin(task.id, agent)) {
      this.#recordError(task.id, new Error(
        'this board revision cannot pin an agent preset on a new card, so the mirror card was created without '
        + agent.name + "'s own preset and was not started; start it by hand once the board supports draft targets",
      ))
      return true
    }
    this.#requestRun(task.id)
    return true
  }

  /**
   * Check that the created card really carries the member's execution targets.
   * @param taskId - the card just created.
   * @param agent - the member it was created for.
   * @returns whether the board kept the pinned preset (no preset means nothing to check).
   */
  #verifyDraftPin(taskId: string, agent: BoundAgent): boolean {
    if (agent.preset === undefined || agent.preset === '') {
      this.#presetPin = 'supported'
      return true
    }
    const created = this.#options.host.tasks.get(taskId)
    if (created !== undefined && created.mode === agent.preset) {
      this.#presetPin = 'supported'
      return true
    }
    this.#presetPin = 'missing'
    if (!this.#problems.includes(DRAFT_PIN_PROBLEM)) this.#problems = [...this.#problems, DRAFT_PIN_PROBLEM]
    return false
  }

  /**
   * Post one agent comment on the issue a card mirrors.
   *
   * The agent identity is the hub record this Host registered for the member the
   * card was claimed for: the hub only accepts agent comments from the token
   * holder that owns that agent, so the id comes from the payload instead of
   * from whatever the model named.
   * @param input - the card or issue to comment on, and the markdown body.
   * @returns the stored comment's id.
   */
  async postComment(input: { taskId?: string; issueId?: string; text: string }): Promise<{ issueId: string; commentId: string }> {
    const linked = this.#linked()
    const task = input.taskId === undefined
      ? (input.issueId === undefined ? undefined : findLinkedTask(linked, input.issueId))
      : this.#options.host.tasks.get(input.taskId)
    if (task === undefined) throw new Error('no team card matches this comment')
    const link = readTaskIssueLink(task)
    if (link === undefined) throw new Error('that card does not mirror a team issue')
    const agentId = link.agentId ?? this.#hubAgentIdOf(link.agentMemberId ?? '')
    if (agentId === undefined) throw new Error('no hub agent record is bound to that card yet')
    const comment = await this.#options.hub.createComment(link.issueId, {
      content: input.text,
      author_type: 'agent',
      author_agent_id: agentId,
    })
    this.#recordComment({ comment })
    return { issueId: link.issueId, commentId: comment.id }
  }

  #requestRun(taskId: string): void {
    const run = this.#options.requestRun
    if (run === undefined) {
      this.#recordError(taskId, new Error('this board revision serves no way to start an execution; open the card and run it from the board'))
      return
    }
    try {
      run(taskId)
    } catch (error) {
      this.#recordError(taskId, error)
    }
  }

  #ensureLease(task: TaskRecord, issueId: string, leaseToken: string): void {
    this.#releaseLease(task.id)
    const renew = (): void => {
      void this.#options.hub.renewLease(issueId, leaseToken).then(renewed => {
        this.#writeLink(task.id, { leaseExpiresAt: renewed.lease_expires_at })
      }).catch((error: unknown) => {
        // LEASE_EXPIRED is the one refusal that means the lease is gone: keeping
        // the timer would renew a lease the hub no longer has.
        if (error instanceof HubError && error.code === 'LEASE_EXPIRED') {
          this.#releaseLease(task.id)
          this.#recordError(task.id, error)
          return
        }
        this.#options.log?.('lease renewal failed for ' + issueId, error)
      })
    }
    this.#leases.set(task.id, this.#options.timers.interval(renew, LEASE_RENEW_INTERVAL_MS))
    renew()
  }

  #releaseLease(taskId: string): void {
    const cancel = this.#leases.get(taskId)
    if (cancel === undefined) return
    cancel()
    this.#leases.delete(taskId)
  }

  async #deliverMention(payload: Record<string, unknown>): Promise<void> {
    const issueId = typeof payload.issue_id === 'string' ? payload.issue_id : undefined
    const content = typeof payload.content === 'string' ? payload.content : ''
    if (issueId === undefined || content.trim() === '') return
    const author = typeof payload.author === 'string' && payload.author !== '' ? payload.author : 'a team member'
    const task = findLinkedTask(this.#linked(), issueId)
    if (task === undefined) return
    this.#pushActivity(task.id, issueId, 'comment.mentioned', clip(author + ': ' + content))
    const sessions = this.#options.host.sessions
    const deliver = sessions?.followUp
    if (sessions === undefined || deliver === undefined) {
      // Visible degradation: the mention is kept on the card's activity stream,
      // and the settings section says this board cannot deliver it into the
      // session instead of the message disappearing silently.
      this.#recordError(task.id, new Error('this board revision serves no follow-up delivery, so a mention could not reach the session'))
      return
    }
    try {
      await deliver.call(sessions, task.id, clip(author + ' mentioned this task: ' + content))
    } catch (error) {
      this.#recordError(task.id, error)
    }
  }

  async #rework(payload: Record<string, unknown>): Promise<void> {
    const issueId = typeof payload.issue_id === 'string' ? payload.issue_id : undefined
    if (issueId === undefined) return
    const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : ''
    const task = findLinkedTask(this.#linked(), issueId)
    if (task === undefined) {
      this.#options.log?.('rework requested for an issue this Host does not mirror: ' + issueId)
      return
    }
    // A rework is a NEW attempt and needs a new attempt id: presenting the old one
    // would ask the hub to re-establish a finished attempt.
    const attemptId = this.#options.uuid()
    try {
      const claim = await this.#options.hub.claim(issueId, { execution_attempt_id: attemptId })
      this.#writeLink(task.id, {
        attemptId: claim.execution_attempt_id,
        leaseToken: claim.lease_token,
        leaseExpiresAt: claim.lease_expires_at,
        hubStatus: 'running',
      })
      this.#ensureLease(task, issueId, claim.lease_token)
    } catch (error) {
      // Claim failed: nothing runs. The instructions are not applied and the
      // card is untouched, because a rework the hub did not authorize must not
      // start an execution.
      this.#recordError(task.id, error)
      return
    }
    if (instructions === '') {
      this.#recordError(task.id, new Error('the rework request carried no instructions, so nothing was re-run'))
      return
    }
    this.#applyRework(task.id, instructions)
    this.#publish()
  }

  /**
   * Apply review instructions to one already-mirrored card through the board's
   * rework capability, or report the gap.
   * @param taskId - the card the reviewer sent back.
   * @param instructions - what the reviewer asked for.
   */
  #applyRework(taskId: string, instructions: string): void {
    const rework = this.#options.host.tasks.rework
    if (rework === undefined) {
      this.#recordError(taskId, new Error('this board revision serves no rework, so the review instructions could not be applied'))
      return
    }
    try {
      rework.call(this.#options.host.tasks, taskId, instructions, 'team-hub')
    } catch (error) {
      this.#recordError(taskId, error)
    }
  }

  #recordComment(payload: Record<string, unknown>): void {
    const comment = payload.comment
    if (typeof comment !== 'object' || comment === null) return
    const row = comment as HubComment
    if (typeof row.issue_id !== 'string') return
    const task = findLinkedTask(this.#linked(), row.issue_id)
    if (task === undefined) return
    const view = this.#view(task.id, row.issue_id)
    const author = this.#authorLabel(row)
    const entry: TeamCommentView = {
      id: typeof row.id === 'string' ? row.id : this.#options.uuid(),
      author,
      content: clip(typeof row.content === 'string' ? row.content : ''),
      createdAt: typeof row.created_at === 'number' ? row.created_at : this.#options.now(),
    }
    view.comments = [...view.comments, entry].slice(-VIEW_ENTRY_LIMIT)
    this.#pushActivity(task.id, row.issue_id, 'comment.created', entry.content)
    this.#publish()
  }

  /**
   * Render one comment author the way a reader recognizes them.
   *
   * An agent author resolves to the member name this Host registered, and a human
   * author to the display name the card already knows; a name this Host cannot
   * resolve reads as "team member" rather than as a raw `mem_...` identifier,
   * which tells a reader nothing about who is speaking.
   * @param comment - the comment row the hub served.
   * @returns the label the detail section renders.
   */
  #authorLabel(comment: HubComment): string {
    const agentId = typeof comment.author_agent_id === 'string' ? comment.author_agent_id : undefined
    if (agentId !== undefined) {
      const agent = this.#hubAgents.get(agentId)
      if (agent !== undefined) return agent.name
      return 'team agent'
    }
    const memberId = typeof comment.author_member_id === 'string' ? comment.author_member_id : undefined
    if (memberId !== undefined) {
      for (const view of this.#cards.values()) {
        if (view.reviewerMemberId === memberId && view.reviewer !== undefined) return view.reviewer
        if (view.assigneeMemberId === memberId && view.assignee !== undefined) return view.assignee
      }
    }
    return 'team member'
  }

  #recordStatus(payload: Record<string, unknown>): void {
    const issueId = typeof payload.issue_id === 'string' ? payload.issue_id : undefined
    const status = readStatus(payload.new_status)
    if (issueId === undefined || status === undefined) return
    const task = findLinkedTask(this.#linked(), issueId)
    if (task === undefined) return
    const view = this.#view(task.id, issueId)
    view.hubStatus = status
    this.#pushActivity(task.id, issueId, 'issue.status_changed', status)
    this.#writeLink(task.id, { hubStatus: status })
    // A lease that lapsed puts the issue back in the pool the hub offers this
    // Host; the sweep turns that into a renewed claim, never a second card. A
    // terminal status releases the lease on this side.
    if (status === 'assigned' || status === 'waiting_host') this.requestSweep()
    if (status === 'done' || status === 'canceled' || status === 'failed') this.#releaseLease(task.id)
    this.#publish()
  }

  #pushActivity(taskId: string, issueId: string, type: string, text: string): void {
    const view = this.#view(taskId, issueId)
    view.activity = [...view.activity, {
      id: this.#options.uuid(),
      type,
      text: clip(text),
      createdAt: this.#options.now(),
    }].slice(-VIEW_ENTRY_LIMIT)
  }

  #view(taskId: string, issueId: string): TeamCardView {
    const existing = this.#cards.get(taskId)
    if (existing !== undefined) {
      existing.issueId = issueId
      return existing
    }
    const created: TeamCardView = { issueId, comments: [], activity: [] }
    this.#cards.set(taskId, created)
    return created
  }

  #recordError(taskId: string, error: unknown): void {
    const message = describe(error)
    this.#lastError = message
    const view = this.#cards.get(taskId)
    if (view !== undefined) view.lastError = message
    if (this.#options.host.tasks.get(taskId) !== undefined) this.#writeLink(taskId, { lastError: message })
    this.#options.log?.(message)
    this.#publish()
  }

  #writeLink(taskId: string, patch: Partial<TeamIssueLink>): void {
    const task = this.#options.host.tasks.get(taskId)
    if (task === undefined) return
    const current = readTaskIssueLink(task)
    if (current === undefined) return
    const merged: TeamIssueLink = { ...current, ...patch }
    try {
      this.#options.host.integration.write(taskId, toPayload(merged))
    } catch (error) {
      this.#options.log?.('integration write failed for ' + taskId, error)
      return
    }
    const view = this.#cards.get(taskId)
    if (view !== undefined && merged.hubStatus !== undefined) view.hubStatus = merged.hubStatus
  }

  #linked(): readonly TaskBoardLinkedTask[] {
    try {
      return this.#options.host.tasks.linked()
    } catch {
      return []
    }
  }

  #agentFor(issue: HubIssue): BoundAgent | undefined {
    const hubAgentId = issue.assignee_agent_id
    if (hubAgentId === undefined) return undefined
    const known = this.#hubAgents.get(hubAgentId)
    if (known !== undefined) return known
    // A hub that answers registration without agent records still filters by
    // assignee_host_id, so an issue reaching this point is offered to this Host;
    // the agent is then resolved by the name it registered under.
    return this.#agents.find(agent => agent.name === hubAgentId)
  }

  #hubAgentIdOf(memberId: string): string | undefined {
    for (const [hubId, agent] of this.#hubAgents) {
      if (agent.memberId === memberId) return hubId
    }
    return undefined
  }

  #publish(): void {
    try {
      this.#options.host.publish(this.summary() as unknown as Record<string, unknown>)
    } catch (error) {
      this.#options.log?.('summary publish failed', error)
    }
  }
}

/** Read one status string into the collaboration vocabulary. */
function readStatus(raw: unknown): HubIssueStatus | undefined {
  switch (raw) {
    case 'todo':
    case 'assigned':
    case 'waiting_host':
    case 'running':
    case 'in_review':
    case 'done':
    case 'canceled':
    case 'failed':
      return raw
    default:
      return undefined
  }
}

/** Read the agent records one registration answered with. */
function readAgentRecords(registered: unknown): Array<{ id: string; name: string }> {
  if (typeof registered !== 'object' || registered === null) return []
  const agents = (registered as { agents?: unknown }).agents
  if (!Array.isArray(agents)) return []
  const records: Array<{ id: string; name: string }> = []
  for (const entry of agents) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id === 'string' && typeof record.name === 'string') {
      records.push({ id: record.id, name: record.name })
    }
  }
  return records
}

/** One error as the summary and the log carry it. */
function describe(error: unknown): string {
  if (error instanceof HubError) return error.code + ': ' + error.message
  if (error instanceof Error) return error.message
  return String(error)
}