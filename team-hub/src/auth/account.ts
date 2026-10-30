import { fail } from '../errors'
import { transportOf } from '../outbound'
import type { MemberRow } from '../types'
import { issueSession, type SessionTokens } from './session'

/**
 * Account-service sign-in.
 *
 * The account service is the only identity source: it signs a short-lived ES256
 * assertion whose `sub` is the account user id, and this hub trusts nothing but
 * that signature over the published JWKS. A verified assertion never creates a
 * member — it only opens a session for a member that was already bound to that
 * account. GitHub login stays as the transition entry point, so that binding is
 * made from a GitHub session through POST /auth/account/link.
 */

export interface AccountConfig {
  jwksUrl: string
  issuer: string
  audience: string
}

/** The three settings POST /auth/account needs; any one missing closes the route. */
export function accountConfig(env: Env): AccountConfig | null {
  const jwksUrl = (env.ACCOUNT_JWKS_URL ?? '').trim()
  const issuer = (env.ACCOUNT_ISSUER ?? '').trim()
  const audience = (env.ACCOUNT_AUDIENCE ?? '').trim()
  if (jwksUrl === '' || issuer === '' || audience === '') return null
  return { jwksUrl, issuer, audience }
}

function fromBase64url(value: string): Uint8Array {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** One JWS segment as a JSON object; anything else is a malformed assertion. */
function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64url(segment)))
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('UNAUTHORIZED', 'The account assertion carries a segment that is not a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/**
 * Fetch the account service JWKS. The document is published by the account
 * service and read through the same transport seam GitHub and APNs use, so the
 * test suite can serve it without touching the network.
 */
async function fetchJwks(env: Env, url: string): Promise<Record<string, unknown>[]> {
  const response = await transportOf(env)(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
  }).catch(() => null)
  if (response === null) {
    fail('ACCOUNT_UNAVAILABLE', 'The account service JWKS could not be reached.', { jwks_url: url })
  }
  if (response.status !== 200) {
    fail('ACCOUNT_UNAVAILABLE', 'The account service answered the JWKS request with ' + response.status + '.', {
      jwks_status: response.status,
    })
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const declared =
    typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined
  const keys = Array.isArray(declared) ? declared : []
  const usable = keys.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
  if (usable.length === 0) {
    fail('ACCOUNT_UNAVAILABLE', 'The account service JWKS publishes no key.', { jwks_url: url })
  }
  return usable
}

/** Pick the published P-256 key the assertion names by kid and import it for verification. */
async function selectVerificationKey(env: Env, config: AccountConfig, kid: string): Promise<CryptoKey> {
  const jwks = await fetchJwks(env, config.jwksUrl)
  const jwk = jwks.find((candidate) => candidate.kid === kid)
  if (jwk === undefined) {
    fail('UNAUTHORIZED', 'The account assertion names a key id the account service does not publish.', { kid })
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    fail('ACCOUNT_UNAVAILABLE', 'The account service published a key that is not a P-256 public key.', { kid })
  }
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    fail('ACCOUNT_UNAVAILABLE', 'The account service key could not be imported.', { kid })
  }
}

/**
 * Verify one assertion and return the account user id it names.
 *
 * Signature first, then the three claims this hub can check for itself: `iss`
 * and `aud` must be exactly the configured values, and `exp` must still be
 * ahead of the hub clock. The account service caps the lifetime at five minutes;
 * this side only refuses what has already expired.
 */
async function verifyAssertion(
  env: Env,
  config: AccountConfig,
  assertion: string,
  now: number,
): Promise<{ sub: string }> {
  const parts = assertion.split('.')
  const [encodedHeader, encodedClaims, encodedSignature] = parts
  if (parts.length !== 3 || encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined) {
    fail('UNAUTHORIZED', 'The account assertion is not a three-part JWS.')
  }
  const header = decodeSegment(encodedHeader)
  if (header.alg !== 'ES256') {
    fail('UNAUTHORIZED', 'The account assertion is not signed with ES256.')
  }
  const kid = typeof header.kid === 'string' ? header.kid : ''
  if (kid === '') fail('UNAUTHORIZED', 'The account assertion names no key id.')

  const key = await selectVerificationKey(env, config, kid)
  let verified = false
  try {
    verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64url(encodedSignature),
      new TextEncoder().encode(encodedHeader + '.' + encodedClaims),
    )
  } catch {
    verified = false
  }
  if (!verified) {
    fail('UNAUTHORIZED', 'The account assertion signature does not match the account service key.', { kid })
  }

  const claims = decodeSegment(encodedClaims)
  if (claims.iss !== config.issuer) {
    fail('UNAUTHORIZED', 'The account assertion was issued by another service.', { issuer: claims.iss })
  }
  const audience = claims.aud
  const audienceOk =
    typeof audience === 'string' ? audience === config.audience : Array.isArray(audience) && audience.includes(config.audience)
  if (!audienceOk) {
    fail('UNAUTHORIZED', 'The account assertion is addressed to another audience.', { audience: claims.aud })
  }
  const exp = typeof claims.exp === 'number' ? claims.exp : Number.NaN
  if (!Number.isFinite(exp) || exp * 1000 <= now) {
    fail('UNAUTHORIZED', 'The account assertion has expired.')
  }
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : ''
  if (sub === '') fail('UNAUTHORIZED', 'The account assertion names no account user id.')
  return { sub }
}

export interface AccountSignIn {
  member: MemberRow
  tokens: SessionTokens
}

/**
 * POST /auth/account: a verified assertion opens a hub session for the member
 * already bound to that account. An unbound account is refused with NOT_LINKED
 * instead of being turned into a member — membership is an admin decision, never
 * a side effect of holding a valid credential.
 */
export async function signInWithAccountAssertion(
  env: Env,
  assertion: string,
  now: number,
): Promise<AccountSignIn> {
  const config = accountConfig(env)
  if (config === null) {
    fail('NOT_CONFIGURED', 'The account service settings (ACCOUNT_JWKS_URL, ACCOUNT_ISSUER, ACCOUNT_AUDIENCE) are not configured on this hub.')
  }
  const { sub } = await verifyAssertion(env, config, assertion, now)
  const member = await env.DB.prepare('SELECT * FROM members WHERE account_user_id = ?')
    .bind(sub)
    .first<MemberRow>()
  if (!member) {
    fail('NOT_LINKED', 'No member of this hub is bound to this account yet.', { sub })
  }
  if (member.status !== 'active') {
    fail('FORBIDDEN', 'The membership bound to this account is not active.')
  }
  const session = await issueSession(env, member, now)
  // last_seen has no column of its own on members; updated_at is the row's only
  // activity timestamp, so a successful account sign-in touches it.
  await env.DB.prepare('UPDATE members SET updated_at = ? WHERE id = ?').bind(now, member.id).run()
  return { member: { ...member, updated_at: now }, tokens: session.tokens }
}

/**
 * POST /auth/account/link: bind the account to the member whose hub session
 * carried the call. Two refusals keep one account on one member: an account
 * another member already holds is IDENTITY_TAKEN, and a member that already
 * carries a different account is CONFLICT (rebinding would silently move an
 * identity). Repeating the same binding is a no-op.
 */
export async function linkAccountIdentity(
  env: Env,
  member: MemberRow,
  assertion: string,
  now: number,
): Promise<MemberRow> {
  const config = accountConfig(env)
  if (config === null) {
    fail('NOT_CONFIGURED', 'The account service settings (ACCOUNT_JWKS_URL, ACCOUNT_ISSUER, ACCOUNT_AUDIENCE) are not configured on this hub.')
  }
  const { sub } = await verifyAssertion(env, config, assertion, now)
  if (member.account_user_id === sub) return member
  if (member.account_user_id !== null) {
    fail('CONFLICT', 'This member is already bound to another account.', { field: 'account_user_id' })
  }
  const holder = await env.DB.prepare('SELECT id FROM members WHERE account_user_id = ? AND id <> ?')
    .bind(sub, member.id)
    .first<{ id: string }>()
  if (holder) {
    fail('IDENTITY_TAKEN', 'This account is already bound to another member.', { member_id: holder.id })
  }
  try {
    await env.DB.prepare('UPDATE members SET account_user_id = ?, updated_at = ? WHERE id = ?')
      .bind(sub, now, member.id)
      .run()
  } catch {
    // The partial unique index is the last word: two members racing for one
    // account end with the same answer the pre-check gives.
    fail('IDENTITY_TAKEN', 'This account is already bound to another member.')
  }
  return { ...member, account_user_id: sub, updated_at: now }
}
