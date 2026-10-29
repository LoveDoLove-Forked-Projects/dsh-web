import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import registerSample from '../contract/register.json'
import heartbeatSample from '../contract/heartbeat.json'
import issuesListSample from '../contract/issues-list.json'
import claimSample from '../contract/claim.json'
import renewLeaseSample from '../contract/renew-lease.json'
import settleSample from '../contract/settle.json'
import questionsSample from '../contract/questions.json'
import withdrawSample from '../contract/withdraw.json'
import commentsSample from '../contract/comments.json'
import commentsListSample from '../contract/comments-list.json'
import wsHandshake from '../contract/ws-handshake.json'
import wsEvents from '../contract/ws-events.json'
import { api, createEnv, externalTransport, seedHost, seedTeam, T0, tokenFor, upgrade, type GithubAccount } from './helpers'
import { channelState } from '../src/channel'
import { sweepAllTeams } from '../src/domain/sweep'
import { QUESTION_TTL_MS } from '../src/constants'

const OCTOCAT: GithubAccount = { id: 1001, login: 'octocat', name: 'Octo Cat', avatar_url: null }
const HUBOT: GithubAccount = { id: 1002, login: 'hubot', name: 'Hub Ot', avatar_url: null }

interface Mismatch {
  path: string
  problem: string
}

/**
 * Structural comparison against a contract sample: the same keys at every
 * object level and the same value types. Anything the hub adds, drops or turns
 * into another type shows up here, which is how both sides stay in step.
 */
function compareShape(live: unknown, sample: unknown, path: string, out: Mismatch[]): void {
  // A null in a sample marks a field whose value depends on the moment the
  // event happened (a lease that did not exist yet, an answer still missing).
  // The key set, the array lengths and the shape of every present value still
  // carry the drift signal, in both directions.
  if (sample === null || live === null) return
  if (Array.isArray(sample)) {
    if (!Array.isArray(live)) {
      out.push({ path, problem: 'expected an array' })
      return
    }
    if (live.length !== sample.length) {
      out.push({ path, problem: live.length + ' element(s) but the sample has ' + sample.length })
    }
    const shared = Math.min(live.length, sample.length)
    for (let index = 0; index < shared; index += 1) {
      compareShape(live[index], sample[index], path + '[' + index + ']', out)
    }
    return
  }
  if (typeof sample === 'object') {
    if (typeof live !== 'object' || live === null || Array.isArray(live)) {
      out.push({ path, problem: 'expected an object' })
      return
    }
    const sampleKeys = Object.keys(sample as Record<string, unknown>).sort()
    const liveKeys = Object.keys(live as Record<string, unknown>).sort()
    if (sampleKeys.join(',') !== liveKeys.join(',')) {
      out.push({ path, problem: 'keys [' + liveKeys.join(',') + '] but the sample has [' + sampleKeys.join(',') + ']' })
    }
    for (const key of sampleKeys) {
      if (!(key in (live as Record<string, unknown>))) continue
      compareShape((live as Record<string, unknown>)[key], (sample as Record<string, unknown>)[key], path + '.' + key, out)
    }
    return
  }
  if (typeof live !== typeof sample) out.push({ path, problem: typeof live + ' instead of ' + typeof sample })
}

interface LiveIds {
  teamId: string
  adminId: string
  hostId: string
  agentId: string
  issueId: string
}

/**
 * Replace the sample's example identifiers with the live ones, so the request a
 * test sends is the request the contract documents.
 */
function materialize(sample: unknown, live: LiveIds, lease: string | null, attempt: string | null, key?: string): unknown {
  if (typeof sample === 'string') {
    if (key === 'lease_token' && lease !== null) return lease
    if (key === 'execution_attempt_id' && attempt !== null) return attempt
    if (sample.startsWith('team_')) return live.teamId
    if (sample.startsWith('mem_')) return live.adminId
    if (sample.startsWith('host_')) return live.hostId
    if (sample.startsWith('agent_')) return live.agentId
    if (sample.startsWith('issue_')) return live.issueId
    return sample
  }
  if (Array.isArray(sample)) return sample.map((entry) => materialize(entry, live, lease, attempt, key))
  if (sample !== null && typeof sample === 'object') {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(sample)) out[name] = materialize(value, live, lease, attempt, name)
    return out
  }
  return sample
}

interface ContractFixture {
  env: Env
  teamId: string
  adminToken: string
  memberToken: string
  hostToken: string
  hostId: string
  agentId: string
  issueId: string
  ids: LiveIds
}

/** A team, one registered host with one agent, and an agent card in review. */
async function fixture(): Promise<ContractFixture> {
  const env = createEnv(externalTransport({ github: { accounts: [OCTOCAT, HUBOT] } }).transport)
  const team = await seedTeam(env)
  const adminToken = await tokenFor(env, team.admin)
  const memberToken = await tokenFor(env, team.member)
  const host = await seedHost(env, team.teamId, adminToken, {
    hostname: 'macbook-pro-14',
    agents: [{ name: 'qa-bot', preset_id: 'liangshen' }],
  })
  const created = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues', {
    token: adminToken,
    body: { title: 'Confirm the API endpoint', assignee_type: 'agent', assignee_id: host.agents[0]?.id },
  })
  const issueId = created.body.issue.id as string
  const claimed = await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/claim', {
    token: host.hostToken,
    body: {},
  })
  await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/settle', {
    token: host.hostToken,
    body: { outcome: 'succeeded', execution_attempt_id: claimed.body.execution_attempt_id },
  })
  // A rejection is what puts the pending rework signal on the card, which the
  // issue list sample documents.
  await api(env, 'POST', '/api/v1/teams/' + team.teamId + '/issues/' + issueId + '/review/reject', {
    token: adminToken,
    body: { instructions: 'Add the regression test before settling again' },
  })
  return {
    env,
    teamId: team.teamId,
    adminToken,
    memberToken,
    hostToken: host.hostToken,
    hostId: host.hostId,
    agentId: host.agents[0]?.id as string,
    issueId,
    ids: {
      teamId: team.teamId,
      adminId: team.admin.id,
      hostId: host.hostId,
      agentId: host.agents[0]?.id as string,
      issueId,
    },
  }
}

describe('contract samples', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('host registration answers exactly the documented shape', async () => {
    // Given another host that already owns one of the names the sample reports,
    // and the documented registration body
    const context = await fixture()
    await seedHost(context.env, context.teamId, context.adminToken, {
      hostname: 'host-other',
      agents: [{ name: 'shared-bot', preset_id: 'reviewer' }],
    })
    const body = materialize(registerSample.request.body, context.ids, null, null) as Record<string, unknown>

    // When the host registers through the documented interface
    const result = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/hosts/register', {
      token: context.hostToken,
      body,
    })

    // Then the response matches the sample field for field
    const mismatches: Mismatch[] = []
    expect(result.status).toBe(registerSample.response.status)
    compareShape(result.body, registerSample.response.body, 'register', mismatches)
    expect(mismatches).toEqual([])
    expect(result.body.agents.map((agent: { name: string }) => agent.name)).toEqual(['qa-bot', 'review-bot'])
    expect(result.body.conflicts).toEqual([
      { name: 'shared-bot', reason: 'agent name already belongs to another host' },
    ])
  })

  it('operator sees the comparator reject a drift in a later array element', () => {
    // Given a sample with two entries and a live value whose second entry drifted
    const sample = { items: [{ id: 'a', state: 'ok' }, { id: 'b', state: 'ok' }] }
    const live = { items: [{ id: 'a', state: 'ok' }, { id: 'b', state: 'ok', extra: 'drift' }] }
    const mismatches: Mismatch[] = []

    // When the two are compared
    compareShape(live, sample, 'probe', mismatches)

    // Then the second element is reported, which comparing only the first would miss
    expect(mismatches.map((entry) => entry.path)).toEqual(['probe.items[1]'])
  })

  it('host heartbeat answers exactly the documented shape', async () => {
    // Given a registered host
    const context = await fixture()

    // When it heartbeats
    const result = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/hosts/' + context.hostId + '/heartbeat',
      { token: context.hostToken },
    )

    // Then the response matches the sample
    const mismatches: Mismatch[] = []
    expect(result.status).toBe(heartbeatSample.response.status)
    compareShape(result.body, heartbeatSample.response.body, 'heartbeat', mismatches)
    expect(mismatches).toEqual([])
  })

  it('host issue list answers exactly the documented shape including the rework signal', async () => {
    // Given a card that carries pending rework instructions
    const context = await fixture()
    const query = materialize(issuesListSample.request.query, context.ids, null, null) as Record<string, string>

    // When the host polls its queue
    const result = await api(context.env, 'GET', '/api/v1/teams/' + context.teamId + '/issues', {
      token: context.hostToken,
      query,
    })

    // Then the list matches the sample, which is how the pending rework is read
    const mismatches: Mismatch[] = []
    expect(result.status).toBe(issuesListSample.response.status)
    compareShape(result.body, issuesListSample.response.body, 'issues', mismatches)
    expect(mismatches).toEqual([])
    expect(result.body.issues[0]).toMatchObject({
      status: 'assigned',
      rework_instructions: 'Add the regression test before settling again',
    })
  })

  it('host comment thread answers exactly the documented shape', async () => {
    // Given a card with one agent comment on it
    const context = await fixture()
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments', {
      token: context.hostToken,
      body: { content: 'Starting the run, will report back.', author_type: 'agent', author_agent_id: context.agentId },
    })

    // When the host reads the thread through the documented interface
    const result = await api(
      context.env,
      'GET',
      '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments',
      { token: context.hostToken },
    )

    // Then the thread matches the sample entry for entry
    const mismatches: Mismatch[] = []
    expect(result.status).toBe(commentsListSample.response.status)
    compareShape(result.body, commentsListSample.response.body, 'comments-list', mismatches)
    expect(mismatches).toEqual([])
    expect(result.body.comments).toHaveLength(1)
  })

  it('host claim, renewal and settlement answer exactly the documented shapes', async () => {
    // Given an agent card waiting for its host
    const context = await fixture()

    // When the host claims it through the documented body
    const claim = await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/claim', {
      token: context.hostToken,
      body: materialize(claimSample.request.body, context.ids, null, null),
    })

    // Then the lease response matches the sample
    const claimMismatches: Mismatch[] = []
    expect(claim.status).toBe(claimSample.response.status)
    compareShape(claim.body, claimSample.response.body, 'claim', claimMismatches)
    expect(claimMismatches).toEqual([])

    // When it renews the lease it owns
    const renew = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/renew-lease',
      {
        token: context.hostToken,
        body: materialize(renewLeaseSample.request.body, context.ids, claim.body.lease_token, claim.body.execution_attempt_id),
      },
    )

    // Then the renewal matches the sample
    const renewMismatches: Mismatch[] = []
    expect(renew.status).toBe(renewLeaseSample.response.status)
    compareShape(renew.body, renewLeaseSample.response.body, 'renew', renewMismatches)
    expect(renewMismatches).toEqual([])

    // When it settles with its attempt id
    const settle = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/settle',
      {
        token: context.hostToken,
        body: materialize(settleSample.request.body, context.ids, claim.body.lease_token, claim.body.execution_attempt_id),
      },
    )

    // Then the settlement matches the sample
    const settleMismatches: Mismatch[] = []
    expect(settle.status).toBe(settleSample.response.status)
    compareShape(settle.body, settleSample.response.body, 'settle', settleMismatches)
    expect(settleMismatches).toEqual([])
  })

  it('host comment matches the documented shape', async () => {
    // Given a running card
    const context = await fixture()
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/claim', {
      token: context.hostToken,
      body: {},
    })

    // When the host posts the documented agent comment
    const result = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/comments',
      { token: context.hostToken, body: materialize(commentsSample.request.body, context.ids, null, null) },
    )

    // Then the comment matches the sample
    const mismatches: Mismatch[] = []
    expect(result.status).toBe(commentsSample.response.status)
    compareShape(result.body, commentsSample.response.body, 'comments', mismatches)
    expect(mismatches).toEqual([])
  })

  it('host question and withdrawal match the documented shapes', async () => {
    // Given a running card
    const context = await fixture()
    await api(context.env, 'POST', '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/claim', {
      token: context.hostToken,
      body: {},
    })

    // When the host asks the documented question
    const asked = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/issues/' + context.issueId + '/questions',
      { token: context.hostToken, body: materialize(questionsSample.request.body, context.ids, null, null) },
    )

    // Then the question matches the sample
    const askedMismatches: Mismatch[] = []
    expect(asked.status).toBe(questionsSample.response.status)
    compareShape(asked.body, questionsSample.response.body, 'questions', askedMismatches)
    expect(askedMismatches).toEqual([])

    // When it withdraws that question
    const withdrawn = await api(
      context.env,
      'POST',
      '/api/v1/teams/' + context.teamId + '/questions/' + asked.body.question.id + '/withdraw',
      { token: context.hostToken },
    )

    // Then the withdrawal matches the sample
    const withdrawnMismatches: Mismatch[] = []
    expect(withdrawn.status).toBe(withdrawSample.response.status)
    compareShape(withdrawn.body, withdrawSample.response.body, 'withdraw', withdrawnMismatches)
    expect(withdrawnMismatches).toEqual([])
  })

  it('websocket handshake follows the documented headers and rejections', async () => {
    // Given a member session and the documented handshake
    const context = await fixture()
    const wsPath = '/api/v1/teams/' + context.teamId + '/ws'

    // When the client connects with the documented headers
    const accepted = await upgrade(context.env, wsPath, {
      token: context.memberToken,
      query: { protocol_version: '1.0.0', since_seq: '0' },
    })

    // Then the socket opens and the first frame matches the documented frame
    expect(accepted.status).toBe(101)
    const socket = accepted.webSocket
    if (socket === null) throw new Error('no socket')
    socket.accept()
    const frames: unknown[] = []
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)))
    })
    socket.send(JSON.stringify(wsHandshake.frames.client[0]))
    const frameMismatches: Mismatch[] = []
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThanOrEqual(2)
    })
    compareShape(frames[0], wsHandshake.frames.server[1], 'resync', frameMismatches)
    compareShape(frames[1], wsHandshake.frames.server[0], 'pong', frameMismatches)
    expect(frameMismatches).toEqual([])

    // When the token is put in the query string or the version is dropped
    const withToken = await upgrade(context.env, wsPath, { query: { protocol_version: '1.0.0', token: 'x' } })
    const withoutVersion = await upgrade(context.env, wsPath, { token: context.memberToken, omitProtocol: true })

    // Then both are refused exactly as the sample documents
    expect([withToken.status, withoutVersion.status]).toEqual(
      wsHandshake.rejected.slice(0, 2).map((entry) => entry.status),
    )
  })

  it('every documented websocket event is delivered with the documented payload', async () => {
    // Given a host socket caught up with the channel and the documented catalogue
    const context = await fixture()
    const checkpoint = (await channelState(context.env, context.teamId)).latest_seq
    const opened = await upgrade(context.env, '/api/v1/teams/' + context.teamId + '/ws', {
      token: context.hostToken,
      query: { protocol_version: '1.0.0', since_seq: String(checkpoint) },
    })
    const socket = opened.webSocket
    if (socket === null) throw new Error('no socket')
    socket.accept()
    const received = new Map<string, unknown>()
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { event?: string; payload?: unknown }
      if (frame.event !== undefined && !received.has(frame.event)) received.set(frame.event, frame.payload)
    })
    const base = '/api/v1/teams/' + context.teamId

    // When a card runs through creation, a claim, both kinds of comment, two
    // questions with an answer and a withdrawal, settlement, rejection, and one
    // question is left to expire while the host goes offline
    const created = await api(context.env, 'POST', base + '/issues', {
      token: context.adminToken,
      body: { title: 'Contract lifecycle', assignee_type: 'agent', assignee_id: context.agentId },
    })
    const issueId = created.body.issue.id as string
    const claim = await api(context.env, 'POST', base + '/issues/' + issueId + '/claim', {
      token: context.hostToken,
      body: {},
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/comments', {
      token: context.adminToken,
      body: { content: 'Please pick this up.' },
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/comments', {
      token: context.adminToken,
      body: { content: '@qa-bot please pick this up' },
    })
    const answered = await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostToken,
      body: {
        question_text: 'Which endpoint should ship first?',
        options: [{ label: 'Plan A', description: 'Ship the v1 endpoint' }, { label: 'Plan B', description: 'Stage it behind a flag' }],
        multi_select: false,
      },
    })
    await api(context.env, 'POST', base + '/questions/' + answered.body.question.id + '/answer', {
      token: context.adminToken,
      body: { selected: ['Plan A'], custom: 'Ship the v1 endpoint first' },
    })
    const withdrawn = await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostToken,
      body: { question_text: 'Withdraw me' },
    })
    await api(context.env, 'POST', base + '/questions/' + withdrawn.body.question.id + '/withdraw', {
      token: context.hostToken,
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/questions', {
      token: context.hostToken,
      body: { question_text: 'This one is left to expire' },
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/settle', {
      token: context.hostToken,
      body: { outcome: 'succeeded', execution_attempt_id: claim.body.execution_attempt_id },
    })
    await api(context.env, 'POST', base + '/issues/' + issueId + '/review/reject', {
      token: context.adminToken,
      body: { instructions: 'Add the regression test before settling again' },
    })
    await vi.waitFor(() => {
      // Ten of the twelve events happen before the sweep; expiry and the host
      // going offline arrive with it.
      expect(received.size).toBeGreaterThanOrEqual(10)
    })
    await sweepAllTeams(context.env, T0 + QUESTION_TTL_MS + 1)
    await vi.waitFor(() => {
      expect(received.has('question.expired') && received.has('host.status_changed')).toBe(true)
    })

    // Then every documented event arrived and its payload matches the catalogue
    const mismatches: Mismatch[] = []
    for (const documented of wsEvents.events) {
      if (!received.has(documented.event)) {
        mismatches.push({ path: documented.event, problem: 'event was never delivered' })
        continue
      }
      compareShape(received.get(documented.event), documented.payload, documented.event, mismatches)
    }
    expect(mismatches).toEqual([])
    expect([...received.keys()].sort()).toEqual(wsEvents.events.map((entry) => entry.event).sort())
  })
})