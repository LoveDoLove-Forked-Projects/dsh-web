import { APNS_JWT_TTL_MS } from '../constants'
import { fail } from '../errors'
import { newId } from '../ids'
import { APNS_PRODUCTION_BASE, APNS_SANDBOX_BASE, transportOf } from '../outbound'
import type { PushTokenRow } from '../types'

/** Section 10 alert texts, one builder per APNs category. */
export function assignedAlert(issueNumber: number, title: string): string {
  return 'You were assigned to issue #' + issueNumber + ': ' + title
}

export function questionAskedAlert(agentName: string, issueNumber: number, questionText: string): string {
  return 'Agent ' + agentName + ' asked a question on #' + issueNumber + ': ' + questionText
}

export function reviewRequestedAlert(issueNumber: number, title: string): string {
  return 'Issue #' + issueNumber + ' is ready for review: ' + title
}

export function mentionedAlert(authorName: string, issueNumber: number): string {
  return authorName + ' mentioned you on #' + issueNumber
}

export type PushEventType = 'assigned' | 'question_asked' | 'review_requested' | 'mentioned'

export interface PushNotification {
  teamId: string
  issueId: string
  eventType: PushEventType
  body: string
  questionId?: string
}

interface CachedProviderToken {
  jwt: string
  issuedAt: number
  keyId: string
  teamId: string
}

// Section 13 caches the signed provider token for 50 minutes. This is a
// deployment-wide credential cache, not per-request state: it is keyed by the
// key and team it was signed for, so a changed configuration cannot reuse it.
let providerTokenCache: CachedProviderToken | null = null

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  if (body === '') fail('NOT_CONFIGURED', 'APNS_PRIVATE_KEY_P8 is empty.')
  const binary = atob(body)
  const der = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index)
  return der
}

/** Sign a fresh ES256 provider token (section 10). */
export async function signProviderToken(env: Env, now: number): Promise<string> {
  const header = { alg: 'ES256', kid: env.APNS_KEY_ID, typ: 'JWT' }
  const claims = { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }
  const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)))
  const encodedClaims = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  const signingInput = encodedHeader + '.' + encodedClaims
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.APNS_PRIVATE_KEY_P8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  return signingInput + '.' + base64url(new Uint8Array(signature))
}

/** The cached provider token, re-signed once the section 13 window elapses. */
export async function providerToken(env: Env, now: number): Promise<string> {
  const cached = providerTokenCache
  if (
    cached !== null &&
    cached.keyId === env.APNS_KEY_ID &&
    cached.teamId === env.APNS_TEAM_ID &&
    now - cached.issuedAt < APNS_JWT_TTL_MS
  ) {
    return cached.jwt
  }
  const jwt = await signProviderToken(env, now)
  providerTokenCache = { jwt, issuedAt: now, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID }
  return jwt
}

/** Drop the cached provider token, as a fresh isolate would start without one. */
export function resetProviderTokenCache(): void {
  providerTokenCache = null
}

export function apnsBody(notification: PushNotification): Record<string, unknown> {
  const body: Record<string, unknown> = {
    aps: {
      alert: { title: 'Team Collaboration', body: notification.body },
      sound: 'default',
      badge: 1,
      category: 'TEAM_COLLAB',
    },
    team_id: notification.teamId,
    issue_id: notification.issueId,
    event_type: notification.eventType,
  }
  if (notification.questionId !== undefined) body.question_id = notification.questionId
  return body
}

export interface PushResult {
  delivered: number
  purged: number
  failed: number
}

/**
 * Deliver a notification to every device of the given members. A device APNs
 * reports as 410 Unregistered is deleted, as section 10 requires.
 */
export async function sendPush(
  env: Env,
  recipientMemberIds: string[],
  notification: PushNotification,
  now: number,
): Promise<PushResult> {
  const unique = [...new Set(recipientMemberIds)].filter((id) => id !== '')
  if (unique.length === 0) return { delivered: 0, purged: 0, failed: 0 }
  const placeholders = unique.map(() => '?').join(', ')
  const { results } = await env.DB.prepare('SELECT * FROM push_tokens WHERE member_id IN (' + placeholders + ')')
    .bind(...unique)
    .all<PushTokenRow>()
  if (results.length === 0) return { delivered: 0, purged: 0, failed: 0 }

  const jwt = await providerToken(env, now)
  const body = JSON.stringify(apnsBody(notification))
  const transport = transportOf(env)
  let delivered = 0
  let failed = 0
  const stale: string[] = []
  await Promise.all(
    results.map(async (token) => {
      const base = token.environment === 'production' ? APNS_PRODUCTION_BASE : APNS_SANDBOX_BASE
      const response = await transport(base + '/3/device/' + token.device_token, {
        method: 'POST',
        headers: {
          authorization: 'bearer ' + jwt,
          'apns-topic': token.bundle_id,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body,
      })
      if (response.status === 200) {
        delivered += 1
        return
      }
      if (response.status === 410) {
        stale.push(token.id)
        return
      }
      failed += 1
    }),
  )
  if (stale.length > 0) {
    const marks = stale.map(() => '?').join(', ')
    await env.DB.prepare('DELETE FROM push_tokens WHERE id IN (' + marks + ')')
      .bind(...stale)
      .run()
  }
  return { delivered, purged: stale.length, failed }
}
export interface PushTokenRegistration {
  platform: 'ios' | 'macos'
  deviceToken: string
  bundleId: string
  environment: 'production' | 'sandbox'
}

/** Section 10 step 1: registering the same device twice updates the one row. */
export async function registerPushToken(
  env: Env,
  memberId: string,
  registration: PushTokenRegistration,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO push_tokens (id, member_id, platform, device_token, bundle_id, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(member_id, device_token) DO UPDATE SET platform = excluded.platform, bundle_id = excluded.bundle_id, environment = excluded.environment, updated_at = excluded.updated_at',
  )
    .bind(
      newId('ptok', now),
      memberId,
      registration.platform,
      registration.deviceToken,
      registration.bundleId,
      registration.environment,
      now,
      now,
    )
    .run()
}

/** Section 10 step 3: logout removes the device token of this member. */
export async function deletePushToken(env: Env, memberId: string, deviceToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM push_tokens WHERE member_id = ? AND device_token = ?').bind(memberId, deviceToken).run()
}