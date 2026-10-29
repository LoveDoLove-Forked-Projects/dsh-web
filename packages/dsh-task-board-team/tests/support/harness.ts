/**
 * The test harness: the REAL board plus this provider's REAL extension.
 *
 * The board side is the production Host service and ledger (imported from the
 * board package's own sources), so these specs exercise the board's real create
 * gate, its real execution runner, its real event fanout and its real refusals.
 * The hub side is the specification-conforming fake in \`fake-hub.ts\`. Only the
 * capability seams a deployment may or may not serve (follow-up delivery, rework
 * and the action applier) are composed here, because that is exactly what the
 * provider contract makes optional.
 *
 * @module dsh-task-board-team/tests/support/harness
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { HostTaskLedger } from '../../../dsh-task-board/src/host-ledger.ts'
import { TaskBoardHostService } from '../../../dsh-task-board/src/host-service.ts'
import { PowerInhibitor } from '../../../dsh-task-board/src/power-inhibitor.ts'
import { fixtureWorkspaces } from '../../../dsh-task-board/tests/workspace-fixture.ts'
import type { TaskRecord } from '../../../dsh-task-board/src/core/tasks.ts'
import type { TaskBoardExtensionHost } from '../../src/core/contract.ts'
import { processTimers } from '../../src/core/timers.ts'
import type { BoundAgent } from '../../src/host/bindings.ts'
import { createTeamExtension } from '../../src/host/extension.ts'
import { HubClient } from '../../src/host/hub-client.ts'
import type { TeamSyncService } from '../../src/host/service.ts'
import { FakeHub } from './fake-hub.ts'

/** Fixed clock the board and the provider both read. */
export const NOW = 1_700_000_000_000

const roots: string[] = []

/** One scratch ledger directory. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(dir)
  return dir
}

/** Remove every scratch directory this file created. */
export function cleanupHarness(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
}

type GatewayRequest = { namespace: string; method: string; args: Record<string, unknown> }

/** One prompt the board queued into a session. */
export interface DeliveredPrompt {
  sessionId: string
  text: string
  mode: string
}

/** The gateway the board's runner speaks to. */
export function scriptedGateway() {
  const prompts: DeliveredPrompt[] = []
  const creates: Array<{ workspaceId?: string; agentPreset?: string }> = []
  const sessions: string[] = []
  let created = 0
  async function invoke(request: GatewayRequest): Promise<unknown> {
    const body = (request.args.request ?? {}) as Record<string, unknown>
    // The board's runner fails closed on a preset it cannot resolve, so the
    // deployment this harness speaks for really serves the member's preset.
    if (request.namespace === 'agentPresets' && request.method === 'list') {
      return { presets: [{ id: 'liangshen' }, { id: 'review' }] }
    }
    if (request.namespace !== 'session') throw new Error('unexpected namespace: ' + request.namespace)
    if (request.method === 'modelCatalog') return {}
    // The roster reports every session this gateway opened, idle: a card whose
    // recorded session is still in the roster is the one a rework may continue.
    if (request.method === 'list') return { items: sessions.map(sessionId => ({ sessionId, running: false })) }
    if (request.method === 'create') {
      created += 1
      creates.push(body as { workspaceId?: string; agentPreset?: string })
      const sessionId = 'session-' + String(created)
      sessions.push(sessionId)
      return { sessionId }
    }
    if (request.method === 'rename') return { title: 'x', seq: 1 }
    if (request.method === 'selectModel') return {}
    if (request.method === 'projections') return { values: {} }
    if (request.method === 'prompt') {
      const content = body.content as Array<{ text: string }>
      prompts.push({ sessionId: String(body.sessionId), text: content[0].text, mode: String(body.mode) })
      return { accepted: true }
    }
    throw new Error('unexpected gateway call: ' + request.method)
  }
  return { gateway: { invoke } as unknown as TypertGateway, prompts, creates }
}

/** The provider-side state one harness exposes. */
export interface Harness {
  hub: FakeHub
  board: TaskBoardHostService
  ledger: HostTaskLedger
  agents: BoundAgent[]
  prompts: DeliveredPrompt[]
  creates: Array<{ workspaceId?: string; agentPreset?: string }>
  /** The capability face the board handed the extension, as the provider saw it. */
  face(): TaskBoardExtensionHost
  /** The live provider service. */
  service(): TeamSyncService
  tasks(): readonly TaskRecord[]
  release(): void
}

export interface HarnessOptions {
  agents?: readonly BoundAgent[]
  missingMembers?: readonly string[]
  token?: string
  /** Turn one optional seam OFF to prove the degradation path. */
  withFollowUp?: boolean
  withRework?: boolean
  withRun?: boolean
  /** An error the follow-up seam raises, to prove a refused delivery is visible. */
  followUpError?: Error
  /** Errors the rework seam raises, to prove a refused rework is visible. */
  reworkError?: Error
  /**
   * Whether the board pins a draft's preset, model and effort when creating a
   * card.
   *
   * Defaults to on, because that is the board this provider is written for. The
   * board's create action already carries those fields; the registry revision in
   * this checkout drops them, which is exactly the older board the provider has to
   * degrade for, so `false` routes the create through the plain capability face
   * and exercises the downgrade.
   */
  withDraftPreset?: boolean
  /** Local fallback wait for a claimed question, in minutes; absent means none. */
  questionWaitMinutes?: number
}

/** One bound agent a test can reuse. */
export function boundAgent(overrides: Partial<BoundAgent> = {}): BoundAgent {
  return {
    memberId: 'mem_builder',
    teamId: 'team_1',
    teamName: 'Core',
    name: 'builder',
    preset: 'liangshen',
    ...overrides,
  }
}

/**
 * Build the harness: the real board, the real provider, the fake hub.
 * @param options - which optional seams this board revision serves.
 * @returns the harness the spec drives.
 */
export function makeHarness(options: HarnessOptions = {}): Harness {
  const hub = new FakeHub()
  const { gateway, prompts, creates } = scriptedGateway()
  const ledger = new HostTaskLedger(tempDir(), () => NOW)
  const board = new TaskBoardHostService(gateway, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
    workspaceRegistry: fixtureWorkspaces(),
  })
  const agents = [...(options.agents ?? [boundAgent()])]
  const delivered: Array<{ taskId: string; text: string }> = []
  void delivered
  let captured: TaskBoardExtensionHost | undefined
  let service: TeamSyncService | undefined
  let runCounter = 0

  const extension = createTeamExtension({
    hub: new HubClient({
      hubUrl: () => 'https://hub.example.com',
      teamId: () => 'team_1',
      token: async () => options.token ?? 'th_host_token',
      fetch: hub.fetch,
    }),
    settings: () => ({
      enabled: true,
      hostname: 'test-host',
      bindings: [],
      ...(options.questionWaitMinutes === undefined ? {} : { questionWaitMinutes: options.questionWaitMinutes }),
    }),
    resolveAgents: async () => ({
      agents,
      problems: (options.missingMembers ?? []).map(memberId => 'the bound member ' + memberId + ' is not defined'),
    }),
    connect: hub.connect,
    ...(options.withRun === false ? {} : {
      requestRun: (taskId: string) => {
        runCounter += 1
        board.apply('team-run-' + String(runCounter), { kind: 'run', taskId }, 'team-hub')
      },
    }),
    actionSeat: () => options.withRun !== false,
    timers: processTimers,
    now: () => NOW,
    uuid: (() => {
      let counter = 0
      return () => {
        counter += 1
        return 'local-' + String(counter)
      }
    })(),
    onService: live => { service = live },
    log: (message, detail) => { console.error('[harness]', message, detail instanceof Error ? detail.stack : (detail ?? '')) },
  })

  /**
   * Compose the optional capability seams around the board's own face, exactly
   * the way a deployment decides them: absent means this board revision serves
   * none, which is what the provider has to degrade for.
   */
  const decorated = {
    ...extension,
    start(host: TaskBoardExtensionHost) {
      const face: TaskBoardExtensionHost = {
        ...host,
        // An absent member is how a board revision that serves no such capability
        // looks to a provider, so the harness removes it rather than hiding it.
        sessions: options.withFollowUp === false
          ? undefined
          : {
              followUp: async (taskId: string, text: string): Promise<void> => {
                if (options.followUpError !== undefined) throw options.followUpError
                await host.sessions?.followUp(taskId, text)
              },
            },
        tasks: {
          ...host.tasks,
          ...(options.withDraftPreset === false
            ? {
                // A board revision whose create drops the three execution
                // targets: the provider has to notice and leave the card alone.
                create: (draft: Parameters<typeof host.tasks.create>[0], createOptions?: Parameters<typeof host.tasks.create>[1]) => {
                  const { mode, model, reasoningEffort, ...rest } = draft
                  void mode
                  void model
                  void reasoningEffort
                  return host.tasks.create(rest, createOptions)
                },
              }
            : {}),
          rework: options.withRework === false
            ? undefined
            : (taskId: string, instructions: string, initiator?: string) => {
                if (options.reworkError !== undefined) throw options.reworkError
                host.tasks.rework?.(taskId, instructions, initiator)
              },
        },
      }
      captured = face
      extension.start?.(face)
    },
  }

  const release = board.registerExtension(decorated)

  return {
    hub,
    board,
    ledger,
    agents,
    prompts,
    creates,
    face(): TaskBoardExtensionHost {
      if (captured === undefined) throw new Error('the board did not start the extension')
      return captured
    },
    service(): TeamSyncService {
      if (service === undefined) throw new Error('the provider service is not running')
      return service
    },
    tasks() {
      return ledger.allTasks()
    },
    release() {
      release()
      board.dispose()
      cleanupHarness()
    },
  }
}

/** Drain the provider's fire-and-forget chains: they are promises, not timers. */
export async function flush(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}