/**
 * The frozen wire samples under `team-hub/contract/`.
 *
 * Protocol amendment A4 point 9 freezes one request and one response example per
 * Host endpoint in the hub's own repository (`team-hub/contract/<interface>.json`),
 * and both sides test against the same files so a drift on either side fails a
 * test. This module is the fake hub's reading half: it loads the samples, matches
 * one outgoing call to its sample by method and path template, and compares what
 * the provider actually sent with what the sample shows.
 *
 * The samples are EXAMPLES, not schemas: they carry optional fields only where the
 * example needed one, so the comparison is deliberately two-sided with a small,
 * named allowlist of protocol-optional members an example does not need to show
 * (a reconnect's attempt credentials, a failed settlement's error). Everything the
 * provider invents — a renamed field such as `presetId` — is reported.
 *
 * `Authorization` values in the samples are placeholders, so only the header's
 * presence and its `Bearer ` prefix are compared.
 *
 * @module dsh-task-board-team/tests/support/contract
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file's own location. */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')

/** Directory the hub side publishes its samples into (read-only for this package). */
export const CONTRACT_DIR = join(REPO_ROOT, 'team-hub', 'contract')

/** One frozen sample. */
export interface ContractSample {
  /** Interface id the sample declares, e.g. `hosts.register`. */
  interface: string
  /** File name the sample came from. */
  file: string
  method?: string
  path?: string
  request: RequestExample
  response: ResponseExample
}

/** The request half of one sample. */
export interface RequestExample {
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
}

/** The response half of one sample. */
export interface ResponseExample {
  status?: number
  body?: Record<string, unknown>
}

/** What the loader found. */
export interface ContractSet {
  /** Whether the hub side publishes samples in this checkout. */
  present: boolean
  samples: ContractSample[]
}

/**
 * Protocol-optional members one example does not need to show.
 *
 * Each entry names keys the wire specification explicitly makes optional for that
 * endpoint, so their absence from the example says nothing about their legality.
 */
export const OPTIONAL_BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'issues.claim': ['execution_attempt_id', 'lease_token'],
  'issues.settle': ['error'],
  'hosts.register': [],
}

/**
 * Read every sample the hub side published.
 * @param dir - directory to read; defaults to {@link CONTRACT_DIR}.
 * @returns the samples, or an empty set with `present: false` when none exist.
 */
export function loadContractSamples(dir: string = CONTRACT_DIR): ContractSet {
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return { present: false, samples: [] }
  }
  const samples: ContractSample[] = []
  for (const file of names) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    if (typeof record.interface !== 'string') continue
    const request = typeof record.request === 'object' && record.request !== null
      ? record.request as Record<string, unknown>
      : {}
    const response = typeof record.response === 'object' && record.response !== null
      ? record.response as Record<string, unknown>
      : {}
    samples.push({
      interface: record.interface,
      file,
      ...(typeof record.method === 'string' ? { method: record.method } : {}),
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      request: {
        ...(isRecord(request.headers) ? { headers: request.headers as Record<string, string> } : {}),
        ...(isRecord(request.query) ? { query: request.query as Record<string, string> } : {}),
        ...(isRecord(request.body) ? { body: request.body as Record<string, unknown> } : {}),
      },
      response: {
        ...(typeof response.status === 'number' ? { status: response.status } : {}),
        ...(isRecord(response.body) ? { body: response.body as Record<string, unknown> } : {}),
      },
    })
  }
  return { present: samples.length > 0, samples }
}

function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Match one call to its sample by method and path template.
 * @param set - the loaded samples.
 * @param method - HTTP method of the call.
 * @param path - request path, e.g. `/api/v1/teams/team_1/hosts/register`.
 * @returns the sample, or undefined when the samples do not describe this call.
 */
export function sampleForCall(set: ContractSet, method: string, path: string): ContractSample | undefined {
  const wanted = path.split('?')[0]
  for (const sample of set.samples) {
    if (sample.method !== method || sample.path === undefined) continue
    if (matchesTemplate(sample.path, wanted)) return sample
  }
  return undefined
}

function matchesTemplate(template: string, path: string): boolean {
  const expected = template.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return false
  return expected.every((segment, index) => segment.startsWith(':') ? actual[index] !== '' : segment === actual[index])
}

/** The fields of one call the comparison looks at. */
export interface ActualCall {
  headers: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
  /** Method and path, for the message. */
  method: string
  path: string
}

/**
 * Compare one real call with its sample.
 * @param sample - the frozen sample.
 * @param actual - what the provider really sent.
 * @returns one message per difference; empty means the call matches the example.
 */
export function compareRequest(sample: ContractSample, actual: ActualCall): string[] {
  const problems: string[] = []
  const optional = OPTIONAL_BODY_KEYS[sample.interface] ?? []
  compareHeaders(sample, actual, problems)
  compareKeys(sample.request.query ?? {}, actual.query, sample.interface + ' query', optional, problems)
  const declaredBody = sample.request.body ?? {}
  if (isEmptyBodyExample(sample)) {
    // An example that shows `{}` for a POST still fixes which optional members the
    // specification allows there, and nothing else.
    for (const key of Object.keys(actual.body)) {
      if (!optional.includes(key)) problems.push(sample.interface + ' body.' + key + ' is not part of this interface')
    }
    return problems
  }
  compareKeys(declaredBody, actual.body, sample.interface + ' body', optional, problems)
  compareShape(declaredBody, actual.body, sample.interface + ' body', problems)
  return problems
}

function isEmptyBodyExample(sample: ContractSample): boolean {
  const body = sample.request.body
  return sample.method !== 'GET' && body !== undefined && Object.keys(body).length === 0
}

function compareHeaders(sample: ContractSample, actual: ActualCall, problems: string[]): void {
  const declared = sample.request.headers
  if (declared === undefined) return
  const present = new Set(Object.keys(actual.headers).map(name => name.toLowerCase()))
  for (const name of Object.keys(declared)) {
    const wanted = name.toLowerCase()
    if (!present.has(wanted)) {
      problems.push(sample.interface + ' sends no ' + name + ' header')
      continue
    }
    if (wanted === 'authorization') {
      const value = actual.headers[name] ?? actual.headers[wanted] ?? ''
      if (!/^Bearer \S+$/.test(value)) problems.push(sample.interface + ' Authorization is not a Bearer credential')
    }
  }
}

function compareKeys(
  declared: Record<string, unknown>,
  actual: Record<string, unknown>,
  where: string,
  optional: readonly string[],
  problems: string[],
): void {
  for (const key of Object.keys(actual)) {
    if (key in declared) continue
    if (optional.includes(key)) continue
    problems.push(where + '.' + key + ' is not part of this interface')
  }
  for (const key of Object.keys(declared)) {
    if (key in actual) continue
    if (optional.includes(key)) continue
    problems.push(where + '.' + key + ' is missing')
  }
}

function compareShape(declared: Record<string, unknown>, actual: Record<string, unknown>, where: string, problems: string[]): void {
  for (const [key, value] of Object.entries(declared)) {
    const mine = actual[key]
    if (mine === undefined) continue
    const wanted = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const got = Array.isArray(mine) ? 'array' : mine === null ? 'null' : typeof mine
    if (wanted !== got) problems.push(where + '.' + key + ' is ' + got + ', the sample shows ' + wanted)
  }
}

/**
 * Compare one response body with the sample that describes it.
 * @param sample - the frozen sample.
 * @param body - the body the fake hub is about to answer with.
 * @returns one message per declared member that is missing.
 */
export function compareResponse(sample: ContractSample, body: Record<string, unknown> | undefined): string[] {
  const declared = sample.response.body
  if (declared === undefined || body === undefined) return []
  const problems: string[] = []
  for (const [key, value] of Object.entries(declared)) {
    if (!(key in body)) {
      problems.push(sample.interface + ' response.' + key + ' is missing')
      continue
    }
    const wanted = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const mine = body[key]
    const got = Array.isArray(mine) ? 'array' : mine === null ? 'null' : typeof mine
    if (wanted !== got) problems.push(sample.interface + ' response.' + key + ' is ' + got + ', the sample shows ' + wanted)
  }
  return problems
}
