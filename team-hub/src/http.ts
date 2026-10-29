import {
  PROTOCOL_HEADER,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  REQUEST_BODY_LIMIT_BYTES,
} from './constants'
import { fail } from './errors'

/** JSON response with the protocol version advertised on the way out too. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', [PROTOCOL_HEADER]: PROTOCOL_VERSION, ...headers },
  })
}

export function ok(body: Record<string, unknown> = {}): Response {
  return json({ ok: true, ...body })
}

/** Major version of a candidate version string, or null when unparsable. */
export function majorOf(version: string): number | null {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version.trim())
  const major = match?.[1]
  if (major === undefined) return null
  return Number.parseInt(major, 10)
}

/**
 * Section 1 version negotiation: the major version must match, a higher client
 * minor is compatible, a missing or different major is rejected.
 */
export function requireProtocolVersion(request: Request): void {
  const declared = request.headers.get(PROTOCOL_HEADER)
  if (declared === null || declared.trim() === '') {
    fail('UNSUPPORTED_PROTOCOL_VERSION', `Missing ${PROTOCOL_HEADER} header; this hub serves ${PROTOCOL_VERSION}.`)
  }
  const major = majorOf(declared)
  if (major !== PROTOCOL_MAJOR) {
    fail('UNSUPPORTED_PROTOCOL_VERSION', `Protocol version ${declared} is not compatible with ${PROTOCOL_VERSION}.`, {
      supported: PROTOCOL_VERSION,
    })
  }
}

/** Byte length of a UTF-8 string, the unit every section 11 cap is expressed in. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Read a JSON object body. The section 11 total body cap is enforced before the
 * body is parsed, and a body that is not a JSON object is a validation failure.
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > REQUEST_BODY_LIMIT_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `Request body exceeds ${REQUEST_BODY_LIMIT_BYTES} bytes.`)
  }
  const raw = await request.text()
  if (utf8Length(raw) > REQUEST_BODY_LIMIT_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `Request body exceeds ${REQUEST_BODY_LIMIT_BYTES} bytes.`)
  }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('VALIDATION_FAILED', 'Request body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('VALIDATION_FAILED', 'Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function fieldName(name: string): string {
  return name
}

/** Required non-empty string field. */
export function requireString(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    fail('VALIDATION_FAILED', `${fieldName(name)} is required and must be a non-empty string.`, { field: name })
  }
  return value
}

/** Optional string field; undefined when absent or not a string. */
export function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}

/** Optional boolean field. */
export function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name]
  return typeof value === 'boolean' ? value : undefined
}

/** Optional array field, copied so callers cannot mutate the parsed body. */
export function optionalArray(body: Record<string, unknown>, name: string): unknown[] | undefined {
  const value = body[name]
  return Array.isArray(value) ? [...value] : undefined
}

/** Enforce a byte cap on a string field, reporting the limit in the error. */
export function assertBytes(value: string, cap: number, label: string): void {
  if (utf8Length(value) > cap) {
    fail('VALIDATION_FAILED', `${label} exceeds ${cap} bytes.`, { limit_bytes: cap })
  }
}

/** Enforce a character cap on a string field. */
export function assertChars(value: string, cap: number, label: string): void {
  if ([...value].length > cap) {
    fail('VALIDATION_FAILED', `${label} exceeds ${cap} characters.`, { limit_chars: cap })
  }
}

/** Read a bounded integer query parameter with a default. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) fail('VALIDATION_FAILED', `${name} must be an integer.`, { field: name })
  if (value < min || value > max) {
    fail('VALIDATION_FAILED', `${name} must be between ${min} and ${max}.`, { field: name, min, max })
  }
  return value
}
