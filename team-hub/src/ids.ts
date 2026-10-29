/**
 * Typed prefixed identifiers (PROTOCOL.md section 3): every row id is
 * `<prefix>_<26 base32 characters>`, the character count of the examples in
 * the specification. The 26 characters are a ULID: a 48-bit millisecond
 * timestamp followed by 80 random bits, so ids sort by creation time and never
 * collide inside one millisecond.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_CHARS = 16

export type IdPrefix =
  | 'team'
  | 'mem'
  | 'host'
  | 'agent'
  | 'issue'
  | 'comm'
  | 'act'
  | 'ques'
  | 'ptok'
  | 'rtok'

function encodeTime(timestamp: number): string {
  let out = ''
  let rest = timestamp
  for (let index = 0; index < 10; index += 1) {
    out = CROCKFORD[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_CHARS)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += CROCKFORD[byte % 32]
  return out
}

/** Mint one identifier for the given entity prefix. */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom()}`
}

/** Random lowercase hex string of `bytes` bytes, used for opaque secrets. */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  let out = ''
  for (const byte of buffer) out += byte.toString(16).padStart(2, '0')
  return out
}

/** SHA-256 of a secret, hex encoded; only the hash of a token is ever stored. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
