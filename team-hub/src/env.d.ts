/**
 * Bindings the Worker reads but wrangler.jsonc does not declare, because they
 * are Worker secrets or because they identify the deployment (see README.md).
 * The generated types under .cloudflare/types cover DB and TEAM_CHANNEL.
 *
 * Both the global Env interface and Cloudflare.Env are augmented: Worker code
 * receives Env, while the cloudflare:workers env export is Cloudflare.Env.
 */
interface Env {
  /** GitHub OAuth App client id (not secret). */
  GITHUB_CLIENT_ID: string
  /** GitHub OAuth App client secret. */
  GITHUB_CLIENT_SECRET: string
  /** HMAC key for signed OAuth state and access tokens. */
  TEAM_HUB_SIGNING_SECRET: string
  /** One-shot token that authorises creating the first team and its admin. */
  BOOTSTRAP_TOKEN: string
  /** APNs provider key id. */
  APNS_KEY_ID: string
  /** APNs team id. */
  APNS_TEAM_ID: string
  /** Bundle id the push topic is addressed to. */
  APNS_BUNDLE_ID: string
  /** PEM encoded EC private key for APNs provider tokens. */
  APNS_PRIVATE_KEY_P8: string
  /** JWKS document of the account service; absent closes POST /auth/account. */
  ACCOUNT_JWKS_URL?: string
  /** Issuer the account service stamps on its assertions. */
  ACCOUNT_ISSUER?: string
  /** Audience this hub accepts on an assertion. */
  ACCOUNT_AUDIENCE?: string
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    TEAM_HUB_SIGNING_SECRET: string
    BOOTSTRAP_TOKEN: string
    APNS_KEY_ID: string
    APNS_TEAM_ID: string
    APNS_BUNDLE_ID: string
    APNS_PRIVATE_KEY_P8: string
    ACCOUNT_JWKS_URL?: string
    ACCOUNT_ISSUER?: string
    ACCOUNT_AUDIENCE?: string
  }
}
