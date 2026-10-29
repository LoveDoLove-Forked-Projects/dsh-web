/**
 * Every numeric parameter of PROTOCOL.md section 13 (Open Defaults) and the
 * caps of section 11, in one place. Nothing in this Worker restates one of
 * these numbers inline.
 */

/** Protocol version this Worker serves (section 1). */
export const PROTOCOL_VERSION = '1.0.0'
/** Major component of PROTOCOL_VERSION; the only part that must match. */
export const PROTOCOL_MAJOR = 1
/** Request header carrying the protocol version; WebSocket accepts the same name. */
export const PROTOCOL_HEADER = 'X-Team-Hub-Protocol-Version'

/** Section 13: lease duration. */
export const LEASE_DURATION_MS = 60_000
/** Section 13: heartbeat interval the Host uses. */
export const HEARTBEAT_INTERVAL_MS = 15_000
/** Section 13: 3 missed heartbeats mark a Host offline. */
export const HOST_OFFLINE_THRESHOLD_MS = 45_000
/** Section 13: the Host renews a lease at this cadence. */
export const LEASE_RENEWAL_CADENCE_MS = 20_000
/** Section 13: session access token lifetime; expires_in reports this in seconds (7200). */
export const ACCESS_TOKEN_TTL_MS = 7_200_000
/** Section 13: session refresh token lifetime. */
export const REFRESH_TOKEN_TTL_MS = 2_592_000_000
/** Section 13: a pending question expires after this long. */
export const QUESTION_TTL_MS = 86_400_000
/** Section 13: replay buffer holds at most this many events. */
export const EVENT_BUFFER_MAX_EVENTS = 1_000
/** Section 13: replay buffer holds at most this much wall-clock time. */
export const EVENT_BUFFER_WINDOW_MS = 3_600_000
/** Section 13: APNs provider token cache lifetime. */
export const APNS_JWT_TTL_MS = 3_000_000
/** Section 13: execution summary character limit. */
export const EXECUTION_SUMMARY_LIMIT = 4_000
/** Section 13: issue description byte limit. */
export const ISSUE_DESCRIPTION_LIMIT_BYTES = 65_536
/** Section 13: comment text byte limit. */
export const COMMENT_LIMIT_BYTES = 32_768
/** Section 11: issue title character limit. */
export const ISSUE_TITLE_LIMIT = 256
/** Section 11: total HTTP request body byte limit. */
export const REQUEST_BODY_LIMIT_BYTES = 131_072
/** Section 11: WebSocket text frame byte limit. */
export const WS_FRAME_LIMIT_BYTES = 65_536
/** Section 11: question text byte limit (bounded by the request body cap). */
export const QUESTION_TEXT_LIMIT_BYTES = 32_768
/** Section 11: OAuth state lifetime; a browser round trip is far shorter. */
export const OAUTH_STATE_TTL_MS = 600_000

/** Section 11: rate limit window shared by every quota. */
export const RATE_LIMIT_WINDOW_MS = 60_000
/** Section 11: /auth/* requests per client IP per window. */
export const RATE_LIMIT_AUTH_PER_IP = 20
/** Section 11: member API requests per member per window. */
export const RATE_LIMIT_MEMBER = 120
/** Supplement A4.6: host execution requests per host per window. */
export const RATE_LIMIT_HOST = 120
/** Section 11: WebSocket frames per connection per window. */
export const RATE_LIMIT_WS_FRAMES = 60

/** Section 2: Host Token prefix. */
export const HOST_TOKEN_PREFIX = 'th_host_'
/** Section 2: Host Token entropy, in hex characters. */
export const HOST_TOKEN_HEX_LENGTH = 64

/** Section 4: issue lifecycle values. */
export type IssueStatus =
  | 'todo'
  | 'assigned'
  | 'waiting_host'
  | 'running'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'failed'

/** Section 7: mention syntax. */
export const MENTION_PATTERN = /(?:^|\s)@([a-zA-Z0-9_-]+)/g