import { fileURLToPath } from 'node:url'

/**
 * Every setting the self-hosted hub reads, resolved from the process
 * environment in one place. Nothing here falls back to a working default: a
 * group that is not configured is reported as closed, and the endpoints that
 * depend on it keep answering NOT_CONFIGURED exactly as the Worker does.
 */

/**
 * Name of the HMAC key that signs session access tokens. It is the same secret
 * the Worker reads, so an operator migrating from the Worker keeps one name.
 */
export const SESSION_KEY_ENV = "TEAM_HUB_SESSION_KEY"

export interface GithubSettings {
  clientId: string
  clientSecret: string
}

export interface AccountSettings {
  jwksUrl: string
  issuer: string
  audience: string
}

export interface PushSettings {
  keyId: string
  teamId: string
  bundleId: string
  privateKeyP8: string
}

export interface HubConfig {
  databasePath: string
  host: string
  port: number
  migrationsDir: string
  /** 0 disables the timer; the startup sweep still runs. */
  sweepIntervalMs: number
  sessionSecret: string | null
  bootstrapToken: string | null
  github: GithubSettings | null
  account: AccountSettings | null
  apns: PushSettings | null
}

export interface ConfigReport {
  config: HubConfig
  /** One line per setting group: what is configured, or which routes stay closed. */
  report: string[]
  /** Missing settings that stop the process from starting at all. */
  errors: string[]
}

export type ConfigSource = Record<string, string | undefined>

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function text(source: ConfigSource, name: string): string | null {
  const raw = source[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function group<T>(values: (string | null)[], build: (present: string[]) => T): T | null {
  if (values.some((value) => value === null)) return null
  return build(values as string[])
}

function integerSetting(
  source: ConfigSource,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = text(source, name)
  if (raw === null) return fallback
  if (!/^-?\d+$/.test(raw)) {
    errors.push(name + ' must be an integer, got "' + raw + '".')
    return fallback
  }
  const value = Number.parseInt(raw, 10)
  if (value < min || value > max) {
    errors.push(name + ' must be between ' + min + ' and ' + max + ', got ' + value + '.')
    return fallback
  }
  return value
}

export interface LoadOptions {
  /** Overrides the migrations directory the module resolves relative to itself. */
  migrationsDir?: string
}

export function loadConfig(source: ConfigSource, options: LoadOptions = {}): ConfigReport {
  const errors: string[] = []
  const report: string[] = []

  const databasePath = text(source, 'DATABASE_PATH')
  if (databasePath === null) {
    errors.push('DATABASE_PATH is required: it names the SQLite file this hub owns.')
  }

  const host = text(source, 'HOST') ?? '127.0.0.1'
  const port = integerSetting(source, 'PORT', 8080, 0, 65535, errors)
  if (!LOOPBACK_HOSTS.has(host)) {
    report.push(
      'HOST=' + host + ' is not a loopback address; keep the port unreachable from the network and terminate TLS in a reverse proxy.',
    )
  }

  const migrationsDir = options.migrationsDir ?? text(source, 'MIGRATIONS_DIR') ?? DEFAULT_MIGRATIONS_DIR
  const sweepIntervalMs = integerSetting(source, 'SWEEP_INTERVAL_MS', 60_000, 0, 86_400_000, errors)

  const sessionSecret = text(source, SESSION_KEY_ENV)
  if (sessionSecret === null) {
    errors.push(
      SESSION_KEY_ENV +
        ' is required: without the HMAC key no session token can be signed or verified, so every authenticated route would answer 503.',
    )
  }

  const github = group(
    [text(source, 'GITHUB_CLIENT_ID'), text(source, 'GITHUB_CLIENT_SECRET')],
    ([clientId, clientSecret]) => ({ clientId: clientId as string, clientSecret: clientSecret as string }),
  )
  const account = group(
    [
      text(source, 'ACCOUNT_JWKS_URL'),
      text(source, 'ACCOUNT_ISSUER'),
      text(source, 'ACCOUNT_AUDIENCE'),
    ],
    ([jwksUrl, issuer, audience]) => ({
      jwksUrl: jwksUrl as string,
      issuer: issuer as string,
      audience: audience as string,
    }),
  )
  const apns = group(
    [
      text(source, 'APNS_KEY_ID'),
      text(source, 'APNS_TEAM_ID'),
      text(source, 'APNS_BUNDLE_ID'),
      text(source, 'APNS_PRIVATE_KEY_P8'),
    ],
    ([keyId, teamId, bundleId, privateKeyP8]) => ({
      keyId: keyId as string,
      teamId: teamId as string,
      bundleId: bundleId as string,
      privateKeyP8: privateKeyP8 as string,
    }),
  )
  const bootstrapToken = text(source, 'BOOTSTRAP_TOKEN')

  if (databasePath !== null) report.push('DATABASE_PATH=' + databasePath)
  report.push('PORT=' + port + ' HOST=' + host)
  report.push(
    sessionSecret === null
      ? SESSION_KEY_ENV + ': missing'
      : SESSION_KEY_ENV + ': configured',
  )
  report.push(
    github === null
      ? 'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: missing -> GET /auth/github/* and POST /auth/token answer 503 NOT_CONFIGURED'
      : 'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: configured',
  )
  report.push(
    account === null
      ? 'ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: missing -> POST /auth/account and /auth/account/link answer 503 NOT_CONFIGURED'
      : 'ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: configured',
  )
  report.push(
    apns === null
      ? 'APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: missing -> APNs delivery answers 503 NOT_CONFIGURED'
      : 'APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: configured',
  )
  report.push(
    bootstrapToken === null
      ? 'BOOTSTRAP_TOKEN: missing -> POST /api/v1/bootstrap answers 503 NOT_CONFIGURED'
      : 'BOOTSTRAP_TOKEN: configured',
  )
  report.push(
    sweepIntervalMs === 0
      ? 'SWEEP_INTERVAL_MS=0 (the startup sweep runs once, the timer is disabled)'
      : 'SWEEP_INTERVAL_MS=' + sweepIntervalMs + ' (sweep once at startup, then every ' + sweepIntervalMs + ' ms)',
  )
  report.push('MIGRATIONS_DIR=' + migrationsDir)

  return {
    config: {
      databasePath: databasePath ?? '',
      host,
      port,
      migrationsDir,
      sweepIntervalMs,
      sessionSecret,
      bootstrapToken,
      github,
      account,
      apns,
    },
    report,
    errors,
  }
}

/**
 * Environment values as the shared Worker modules read them. Groups that are
 * not configured stay absent, which is exactly what their own NOT_CONFIGURED
 * guards test for.
 */
export function envValues(config: HubConfig): Record<string, string> {
  const values: Record<string, string> = {}
  if (config.sessionSecret !== null) values[SESSION_KEY_ENV] = config.sessionSecret
  if (config.bootstrapToken !== null) values.BOOTSTRAP_TOKEN = config.bootstrapToken
  if (config.github !== null) {
    values.GITHUB_CLIENT_ID = config.github.clientId
    values.GITHUB_CLIENT_SECRET = config.github.clientSecret
  }
  if (config.account !== null) {
    values.ACCOUNT_JWKS_URL = config.account.jwksUrl
    values.ACCOUNT_ISSUER = config.account.issuer
    values.ACCOUNT_AUDIENCE = config.account.audience
  }
  if (config.apns !== null) {
    values.APNS_KEY_ID = config.apns.keyId
    values.APNS_TEAM_ID = config.apns.teamId
    values.APNS_BUNDLE_ID = config.apns.bundleId
    values.APNS_PRIVATE_KEY_P8 = config.apns.privateKeyP8
  }
  return values
}
