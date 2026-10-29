/**
 * The unified error envelope of PROTOCOL.md section 9: every non-2xx response
 * is `{ error: { code, message, details } }`. A HubError carries the code and
 * the HTTP status its table row assigns, so handlers never pick a status by
 * hand.
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'INVALID_STATE_TRANSITION'
  | 'LEASE_EXPIRED'
  | 'LEASE_HELD_BY_OTHER'
  | 'HOST_OFFLINE'
  | 'QUESTION_ALREADY_ANSWERED'
  | 'QUESTION_NOT_PENDING'
  | 'HOST_MISMATCH'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'INVALID_OAUTH_CODE'
  | 'INVALID_PKCE'
  | 'INVALID_REFRESH_TOKEN'
  | 'USER_NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'MEMBER_NOT_FOUND'
  | 'HOST_NOT_FOUND'
  | 'ISSUE_NOT_FOUND'
  | 'NOT_CONFIGURED'

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 400,
  UNSUPPORTED_PROTOCOL_VERSION: 400,
  INVALID_STATE_TRANSITION: 422,
  LEASE_EXPIRED: 412,
  LEASE_HELD_BY_OTHER: 409,
  HOST_OFFLINE: 400,
  QUESTION_ALREADY_ANSWERED: 409,
  QUESTION_NOT_PENDING: 409,
  HOST_MISMATCH: 403,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  INVALID_OAUTH_CODE: 400,
  INVALID_PKCE: 400,
  INVALID_REFRESH_TOKEN: 401,
  USER_NOT_FOUND: 404,
  ALREADY_MEMBER: 409,
  MEMBER_NOT_FOUND: 404,
  HOST_NOT_FOUND: 404,
  ISSUE_NOT_FOUND: 404,
  NOT_CONFIGURED: 503,
}

export class HubError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HubError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.details = details
  }
}

/** HTTP status an error code maps to, for callers that build their own response. */
export function statusOf(code: ErrorCode): number {
  return STATUS_BY_CODE[code]
}

/** Build the unified body of PROTOCOL.md section 9. */
export function errorBody(error: HubError): {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> }
} {
  return { error: { code: error.code, message: error.message, details: error.details } }
}

/** Throw a HubError from anywhere inside a handler; the entry point renders it. */
export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new HubError(code, message, details)
}