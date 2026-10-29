import {
  PROTOCOL_HEADER,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  RATE_LIMIT_AUTH_PER_IP,
  RATE_LIMIT_HOST,
  RATE_LIMIT_MEMBER,
} from './constants'
import { HubError, errorBody, fail } from './errors'
import {
  intParam,
  json,
  majorOf,
  ok,
  optionalArray,
  optionalBoolean,
  optionalString,
  readJsonBody,
  requireProtocolVersion,
  requireString,
} from './http'
import {
  authenticate,
  requireAdmin,
  requireHost,
  requireMember,
  revokeSession,
  rotateRefreshToken,
  type Principal,
} from './auth/session'
import { GITHUB_CALLBACK_PATH } from './outbound'
import { beginAuthorize, completeAuthorizationCode, handleCallback } from './auth/github'
import { consumeQuota } from './rate-limit'
import { issueHostToken, registerHost, heartbeat, revokeHostToken, type AgentDefinition } from './domain/hosts'
import { describeMe, inviteMember, listMembers, removeMember } from './domain/members'
import {
  approveReview,
  createIssue,
  findIssue,
  listIssues,
  patchIssue,
  rejectReview,
} from './domain/issues'
import { claimIssue, renewLease, settleIssue } from './domain/leases'
import { answerQuestion, createQuestion, listQuestions, withdrawQuestion } from './domain/questions'
import { createComment, listComments } from './domain/comments'
import { getInbox, listActivityFeed, markMentionRead } from './domain/inbox'
import { sweepTeam } from './domain/sweep'
import { toIssueView, toMemberView, toQuestionView } from './types'
import { deletePushToken, registerPushToken } from './push/apns'
import { getTeam } from './domain/members'

type AuthPolicy = 'public' | 'member' | 'admin' | 'host' | 'member-or-host' | 'admin-or-host'

interface RouteContext {
  request: Request
  url: URL
  env: Env
  params: Record<string, string>
  principal: Principal | null
  now: number
}

type ProtocolPolicy = 'header' | 'browser' | 'ws'

interface Route {
  method: string
  path: string
  segments: string[]
  auth: AuthPolicy
  protocol: ProtocolPolicy
  handler: (context: RouteContext) => Promise<Response>
}

function route(
  method: string,
  path: string,
  auth: AuthPolicy,
  handler: Route['handler'],
  protocol: ProtocolPolicy = 'header',
): Route {
  return { method, path, segments: path.split('/').filter((part) => part !== ''), auth, protocol, handler }
}

function memberPrincipal(principal: Principal | null) {
  if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
  return requireMember(principal)
}

function hostPrincipal(principal: Principal | null) {
  if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
  return requireHost(principal)
}

function parseAgentDefinitions(value: unknown): AgentDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('VALIDATION_FAILED', 'agents must be an array.', { field: 'agents' })
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      fail('VALIDATION_FAILED', 'Every agent definition must be an object.', { field: 'agents' })
    }
    const record = entry as Record<string, unknown>
    const name = record.name
    const presetId = record.preset_id
    if (typeof name !== 'string' || name === '') {
      fail('VALIDATION_FAILED', 'Every agent definition needs a name.', { field: 'agents' })
    }
    if (typeof presetId !== 'string' || presetId === '') {
      fail('VALIDATION_FAILED', 'Every agent definition needs a preset_id.', { field: 'agents' })
    }
    const description = typeof record.description === 'string' ? record.description : null
    return { name, preset_id: presetId, description }
  })
}

const ROUTES: Route[] = [
  route('GET', '/auth/github/authorize', 'public', async ({ request, env, now }) => beginAuthorize(env, request, now), 'browser'),
  route('GET', '/auth/github/callback', 'public', async ({ request, env, now }) => handleCallback(env, request, now), 'browser'),
  route('POST', '/auth/token', 'public', async ({ request, env, now }) => {
    const body = await readJsonBody(request)
    const code = requireString(body, 'code')
    const codeVerifier = optionalString(body, 'code_verifier') ?? null
    requireString(body, 'redirect_uri')
    const result = await completeAuthorizationCode(env, {
      code,
      codeVerifier,
      redirectUri: new URL(request.url).origin + GITHUB_CALLBACK_PATH,
      now,
    })
    return json({ ...result.tokens, member: toMemberView(result.member) })
  }),
  route('POST', '/auth/refresh', 'public', async ({ request, env, now }) => {
    const body = await readJsonBody(request)
    const presented = optionalString(body, 'refresh_token') ?? cookieValue(request, 'th_refresh')
    if (presented === null || presented === '') fail('INVALID_REFRESH_TOKEN', 'refresh_token is required.')
    const rotated = await rotateRefreshToken(env, presented, now)
    return json({ ...rotated.tokens, member: toMemberView(rotated.member) })
  }),
  route('POST', '/auth/revoke', 'member', async ({ request, env, now }) => {
    const body = await readJsonBody(request)
    const presented = optionalString(body, 'refresh_token') ?? cookieValue(request, 'th_refresh')
    if (presented === null || presented === '') fail('UNAUTHORIZED', 'refresh_token is required.')
    await revokeSession(env, presented, now)
    return ok()
  }),

  route('GET', '/api/v1/me', 'member', async ({ env, principal }) => {
    const member = memberPrincipal(principal)
    return json(await describeMe(env, member))
  }),

  route('GET', '/api/v1/teams/:teamId/members', 'member', async ({ env, params }) => {
    return json({ members: await listMembers(env, params.teamId as string) })
  }),
  route('POST', '/api/v1/teams/:teamId/members/invite', 'admin', async ({ env, params, principal, now, request }) => {
    const actor = requireAdmin(principal as Principal)
    const body = await readJsonBody(request)
    const githubUsername = requireString(body, 'github_username')
    const role = requireString(body, 'role')
    if (role !== 'admin' && role !== 'member') {
      fail('VALIDATION_FAILED', "role must be 'admin' or 'member'.", { field: 'role' })
    }
    const member = await inviteMember(
      env,
      params.teamId as string,
      actor,
      { github_username: githubUsername, role },
      now,
    )
    return json({ member }, 201)
  }),
  route('DELETE', '/api/v1/teams/:teamId/members/:memberId', 'admin', async ({ env, params, principal, now }) => {
    const actor = requireAdmin(principal as Principal)
    await removeMember(env, params.teamId as string, actor, params.memberId as string, now)
    return ok()
  }),

  route('POST', '/api/v1/teams/:teamId/hosts/tokens', 'admin', async ({ env, params, principal, now, request }) => {
    const actor = requireAdmin(principal as Principal)
    const body = await readJsonBody(request)
    const hostname = requireString(body, 'hostname')
    const minted = await issueHostToken(env, params.teamId as string, actor, { hostname }, now)
    return json(minted, 201)
  }),
  route('POST', '/api/v1/teams/:teamId/hosts/:hostId/revoke-token', 'admin', async ({ env, params, now }) => {
    await revokeHostToken(env, params.teamId as string, params.hostId as string, now)
    return ok()
  }),
  route('POST', '/api/v1/teams/:teamId/hosts/register', 'host', async ({ env, principal, now, request }) => {
    const host = hostPrincipal(principal)
    const body = await readJsonBody(request)
    const hostname = requireString(body, 'hostname')
    const clientVersion = requireString(body, 'client_version')
    const agents = parseAgentDefinitions(body.agents)
    const result = await registerHost(env, host.host, { hostname, client_version: clientVersion, agents }, now)
    return json(result)
  }),
  route('POST', '/api/v1/teams/:teamId/hosts/:hostId/heartbeat', 'host', async ({ env, params, principal, now }) => {
    const host = hostPrincipal(principal)
    return json(await heartbeat(env, host.host, params.hostId as string, now))
  }),

  route('GET', '/api/v1/teams/:teamId/issues', 'member-or-host', async ({ env, params, principal, now, url }) => {
    const teamId = params.teamId as string
    // Hosts poll this endpoint; sweeping here is what turns three missed
    // heartbeats into waiting_host without a separate background timer.
    await sweepTeam(env, teamId, now)
    const statusParam = url.searchParams.get('status')
    const statuses = statusParam === null || statusParam === '' ? undefined : statusParam.split(',').map((s) => s.trim())
    const assignee = url.searchParams.get('assignee') ?? undefined
    const assigneeHostId = url.searchParams.get('assignee_host_id') ?? undefined
    const restrictToHostId = principal !== null && principal.kind === 'host' ? principal.host.id : undefined
    return json({ issues: (await listIssues(env, teamId, { statuses, assignee, assigneeHostId, restrictToHostId })).map(toIssueView) })
  }),
  route('POST', '/api/v1/teams/:teamId/issues', 'member', async ({ env, params, principal, now, request }) => {
    const actor = memberPrincipal(principal)
    const body = await readJsonBody(request)
    const title = requireString(body, 'title')
    const assigneeType = optionalString(body, 'assignee_type')
    const assigneeId = optionalString(body, 'assignee_id')
    const reviewerMemberId = optionalString(body, 'reviewer_member_id')
    if (assigneeType !== undefined && assigneeType !== 'member' && assigneeType !== 'agent') {
      fail('VALIDATION_FAILED', "assignee_type must be 'member' or 'agent'.", { field: 'assignee_type' })
    }
    const issue = await createIssue(
      env,
      params.teamId as string,
      actor,
      {
        title,
        description: optionalString(body, 'description'),
        assignee_type: assigneeType as 'member' | 'agent' | undefined,
        assignee_id: assigneeId,
        reviewer_member_id: reviewerMemberId,
      },
      now,
    )
    return json({ issue: toIssueView(issue) }, 201)
  }),
  route('GET', '/api/v1/teams/:teamId/issues/:issueId', 'member-or-host', async ({ env, params }) => {
    return json({ issue: toIssueView(await findIssue(env, params.teamId as string, params.issueId as string)) })
  }),
  route('PATCH', '/api/v1/teams/:teamId/issues/:issueId', 'member', async ({ env, params, principal, now, request }) => {
    const actor = memberPrincipal(principal)
    const body = await readJsonBody(request)
    const assigneeType = optionalString(body, 'assignee_type')
    if (assigneeType !== undefined && assigneeType !== 'member' && assigneeType !== 'agent') {
      fail('VALIDATION_FAILED', "assignee_type must be 'member' or 'agent'.", { field: 'assignee_type' })
    }
    const updated = await patchIssue(
      env,
      params.teamId as string,
      actor,
      params.issueId as string,
      {
        title: optionalString(body, 'title'),
        description: optionalString(body, 'description'),
        assignee_type: assigneeType as 'member' | 'agent' | undefined,
        assignee_id: optionalString(body, 'assignee_id'),
        reviewer_member_id: optionalString(body, 'reviewer_member_id'),
        status: optionalString(body, 'status'),
      },
      now,
    )
    return json({ issue: toIssueView(updated) })
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/claim', 'host', async ({ env, params, principal, now, request }) => {
    const host = hostPrincipal(principal)
    const body = await readJsonBody(request)
    const claim = await claimIssue(
      env,
      params.teamId as string,
      host,
      params.issueId as string,
      {
        execution_attempt_id: optionalString(body, 'execution_attempt_id'),
        lease_token: optionalString(body, 'lease_token'),
      },
      now,
    )
    return json(claim)
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/renew-lease', 'host', async ({ env, params, principal, now, request }) => {
    const host = hostPrincipal(principal)
    const body = await readJsonBody(request)
    const leaseToken = requireString(body, 'lease_token')
    return json(await renewLease(env, params.teamId as string, host, params.issueId as string, leaseToken, now))
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/settle', 'host', async ({ env, params, principal, now, request }) => {
    const host = hostPrincipal(principal)
    const body = await readJsonBody(request)
    return json(
      await settleIssue(
        env,
        params.teamId as string,
        host,
        params.issueId as string,
        {
          outcome: optionalString(body, 'outcome'),
          summary: optionalString(body, 'summary'),
          error: optionalString(body, 'error'),
          verification_evidence: body.verification_evidence,
          execution_attempt_id: optionalString(body, 'execution_attempt_id'),
        },
        now,
      ),
    )
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/review/approve', 'member', async ({ env, params, principal, now }) => {
    const actor = memberPrincipal(principal)
    const issue = await approveReview(env, params.teamId as string, actor, params.issueId as string, now)
    return json({ ok: true, status: issue.status })
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/review/reject', 'member', async ({ env, params, principal, now, request }) => {
    const actor = memberPrincipal(principal)
    const body = await readJsonBody(request)
    const instructions = requireString(body, 'instructions')
    const issue = await rejectReview(env, params.teamId as string, actor, params.issueId as string, instructions, now)
    return json({ ok: true, status: issue.status })
  }),
  route('GET', '/api/v1/teams/:teamId/issues/:issueId/comments', 'member-or-host', async ({ env, params }) => {
    return json({ comments: await listComments(env, params.teamId as string, params.issueId as string) })
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/comments', 'member-or-host', async ({ env, params, principal, now, request }) => {
    if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
    const body = await readJsonBody(request)
    const content = requireString(body, 'content')
    const comment = await createComment(
      env,
      params.teamId as string,
      principal,
      params.issueId as string,
      {
        content,
        author_type: optionalString(body, 'author_type'),
        author_agent_id: optionalString(body, 'author_agent_id'),
      },
      now,
    )
    return json({ comment }, 201)
  }),
  route('GET', '/api/v1/teams/:teamId/issues/:issueId/activity', 'member', async ({ env, params, url }) => {
    return json(
      await listActivityFeed(env, params.teamId as string, params.issueId as string, {
        before: url.searchParams.get('before') ?? undefined,
        limit: intParam(url, 'limit', 50, 1, 100),
      }),
    )
  }),
  route('POST', '/api/v1/teams/:teamId/issues/:issueId/questions', 'host', async ({ env, params, principal, now, request }) => {
    const host = hostPrincipal(principal)
    const body = await readJsonBody(request)
    const question = await createQuestion(
      env,
      params.teamId as string,
      host,
      params.issueId as string,
      {
        question_text: requireString(body, 'question_text'),
        options: optionalArray(body, 'options'),
        multi_select: optionalBoolean(body, 'multi_select'),
      },
      now,
    )
    return json({ question: toQuestionView(question) }, 201)
  }),
  route('POST', '/api/v1/teams/:teamId/questions/:questionId/answer', 'member', async ({ env, params, principal, now, request }) => {
    const actor = memberPrincipal(principal)
    const body = await readJsonBody(request)
    await answerQuestion(
      env,
      params.teamId as string,
      actor,
      params.questionId as string,
      { selected_options: optionalArray(body, 'selected_options'), custom_text: optionalString(body, 'custom_text') },
      now,
    )
    return ok()
  }),
  route('POST', '/api/v1/teams/:teamId/questions/:questionId/withdraw', 'admin-or-host', async ({ env, params, principal, now }) => {
    if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
    await withdrawQuestion(env, params.teamId as string, principal, params.questionId as string, now)
    return json({ ok: true, status: 'dismissed' })
  }),
  route('GET', '/api/v1/teams/:teamId/questions', 'member', async ({ env, params, url }) => {
    const rows = await listQuestions(env, params.teamId as string, {
      status: url.searchParams.get('status') ?? undefined,
      issueId: url.searchParams.get('issue_id') ?? undefined,
    })
    return json({ questions: rows.map(toQuestionView) })
  }),
  route('GET', '/api/v1/teams/:teamId/inbox', 'member', async ({ env, params, principal }) => {
    return json(await getInbox(env, params.teamId as string, memberPrincipal(principal)))
  }),
  route('POST', '/api/v1/teams/:teamId/inbox/mentions/:commentId/read', 'member', async ({ env, params, principal, now }) => {
    await markMentionRead(env, params.teamId as string, memberPrincipal(principal), params.commentId as string, now)
    return ok()
  }),

  route(
    'GET',
    '/api/v1/teams/:teamId/ws',
    'member-or-host',
    async ({ request, url, env, params, principal }) => {
      if (request.headers.get('Upgrade') !== 'websocket') {
        fail('VALIDATION_FAILED', 'This endpoint requires a WebSocket upgrade.')
      }
      const internal = new URL('https://team-channel.internal/ws')
      const since = url.searchParams.get('since_seq')
      if (since !== null) internal.searchParams.set('since_seq', since)
      const headers = new Headers({ Upgrade: 'websocket' })
      if (principal !== null && principal.kind === 'host') headers.set('x-team-channel-host-id', principal.host.id)
      const stub = env.TEAM_CHANNEL.get(env.TEAM_CHANNEL.idFromName(params.teamId as string))
      return stub.fetch(new Request(internal, { headers }))
    },
    'ws',
  ),

  route('POST', '/api/v1/push-tokens', 'member', async ({ env, principal, now, request }) => {
    const actor = memberPrincipal(principal)
    const body = await readJsonBody(request)
    const platform = requireString(body, 'platform')
    const deviceToken = requireString(body, 'device_token')
    const bundleId = requireString(body, 'bundle_id')
    const environment = requireString(body, 'environment')
    if (platform !== 'ios' && platform !== 'macos') {
      fail('VALIDATION_FAILED', "platform must be 'ios' or 'macos'.", { field: 'platform' })
    }
    if (environment !== 'production' && environment !== 'sandbox') {
      fail('VALIDATION_FAILED', "environment must be 'production' or 'sandbox'.", { field: 'environment' })
    }
    await registerPushToken(env, actor.member.id, { platform, deviceToken, bundleId, environment }, now)
    return ok()
  }),
  route('DELETE', '/api/v1/push-tokens/:token', 'member', async ({ env, principal, params }) => {
    const actor = memberPrincipal(principal)
    await deletePushToken(env, actor.member.id, params.token as string)
    return ok()
  }),
]
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '')
}

function matchRoute(method: string, segments: string[]): { route: Route; params: Record<string, string> } | null {
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue
    if (candidate.segments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < candidate.segments.length; index += 1) {
      const pattern = candidate.segments[index] as string
      const actual = segments[index] as string
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(actual)
        continue
      }
      if (pattern !== actual) {
        matched = false
        break
      }
    }
    if (matched) return { route: candidate, params }
  }
  return null
}

export function routeInventories(): { method: string; path: string; auth: AuthPolicy }[] {
  return ROUTES.map((entry) => ({ method: entry.method, path: entry.path, auth: entry.auth }))
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown'
}

/** Section 1: the WebSocket handshake accepts the version as a query parameter. */
function requireWebSocketProtocolVersion(url: URL, request: Request): void {
  const declared = url.searchParams.get('protocol_version') ?? request.headers.get(PROTOCOL_HEADER)
  if (declared === null || declared.trim() === '') {
    fail('UNSUPPORTED_PROTOCOL_VERSION', 'The WebSocket handshake needs protocol_version=' + PROTOCOL_VERSION + '.')
  }
  if (majorOf(declared) !== PROTOCOL_MAJOR) {
    fail('UNSUPPORTED_PROTOCOL_VERSION', 'Protocol version ' + declared + ' is not compatible.', {
      supported: PROTOCOL_VERSION,
    })
  }
}

/** Section 11 role matrix, applied to the principal kinds each route allows. */
function enforceAuthPolicy(policy: AuthPolicy, principal: Principal | null): void {
  switch (policy) {
    case 'public':
      return
    case 'member':
      if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
      requireMember(principal)
      return
    case 'admin':
      if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
      requireAdmin(principal)
      return
    case 'host':
      if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
      requireHost(principal)
      return
    case 'member-or-host':
      if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
      return
    case 'admin-or-host':
      if (principal === null) fail('UNAUTHORIZED', 'Authentication is required.')
      if (principal.kind === 'host') return
      requireAdmin(principal)
      return
  }
}

async function applyQuota(env: Env, principal: Principal | null, request: Request, now: number): Promise<void> {
  if (principal === null) {
    await consumeQuota(env, 'auth', clientIp(request), RATE_LIMIT_AUTH_PER_IP, now)
    return
  }
  if (principal.kind === 'host') {
    await consumeQuota(env, 'host', principal.host.id, RATE_LIMIT_HOST, now)
    return
  }
  await consumeQuota(env, 'member', principal.member.id, RATE_LIMIT_MEMBER, now)
}

async function dispatch(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url)
  const matched = matchRoute(request.method, segmentsOf(url.pathname))
  if (matched === null) {
    fail('NOT_FOUND', 'No route matches ' + request.method + ' ' + url.pathname + '.')
  }
  const { route: matchedRoute, params } = matched
  if (matchedRoute.protocol === 'header') requireProtocolVersion(request)
  if (matchedRoute.protocol === 'ws') requireWebSocketProtocolVersion(url, request)

  const principal = matchedRoute.auth === 'public' ? null : await authenticate(env, request, now)
  enforceAuthPolicy(matchedRoute.auth, principal)

  const teamId = params.teamId
  if (teamId !== undefined) {
    await getTeam(env, teamId)
    if (principal !== null) {
      const principalTeam = principal.kind === 'host' ? principal.host.team_id : principal.member.team_id
      if (principalTeam !== teamId) {
        if (principal.kind === 'host') fail('HOST_MISMATCH', 'This Host token belongs to another team.')
        fail('FORBIDDEN', 'This member does not belong to the team in the path.')
      }
    }
  }

  await applyQuota(env, principal, request, now)
  return matchedRoute.handler({ request, url, env, params, principal, now })
}

/** Entry point of the Worker: one error boundary for the whole route table. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const now = Date.now()
  try {
    return await dispatch(request, env, now)
  } catch (error) {
    if (error instanceof HubError) return json(errorBody(error), error.status)
    console.error('team-hub unhandled error', error)
    return json(errorBody(new HubError('INTERNAL_ERROR', 'Unhandled internal error.')), 500)
  }
}