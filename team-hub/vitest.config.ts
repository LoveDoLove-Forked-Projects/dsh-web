import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The Worker under test runs on the official local runtime (workerd) with real
// D1 storage and real Durable Objects; TEST_MIGRATIONS carries the parsed SQL
// into the test environment so every test starts from the schema in PROTOCOL.md
// section 3.
const migrations = await readD1Migrations('./migrations')

/**
 * A real ES256 provider key, generated per test run: the APNs push tests sign
 * with it and verify the resulting JWT against the exported public key, so the
 * signature path is exercised exactly as production would.
 */
async function providerKey(): Promise<{ pem: string; publicJwk: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  let binary = ''
  for (const byte of pkcs8) binary += String.fromCharCode(byte)
  const body = btoa(binary).replace(/(.{64})/g, '$1\n')
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return { pem: '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----', publicJwk: JSON.stringify(jwk) }
}

const key = await providerKey()

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The test runtime declares its own bindings rather than reading the deploy
      // configuration: it needs a database id and a Durable Object namespace that
      // exist only in workerd, never the real deployment's.
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'test-database' },
        durableObjects: { TEAM_CHANNEL: { className: 'TeamChannelDO', useSQLite: true } },
        bindings: {
          TEST_MIGRATIONS: migrations,
          GITHUB_CLIENT_ID: 'test-github-client-id',
          GITHUB_CLIENT_SECRET: 'test-github-client-secret',
          TEAM_HUB_SESSION_KEY: 'test-signing-secret-for-local-tests-only',
          APNS_KEY_ID: 'ABC1234567',
          APNS_TEAM_ID: 'TEAM123456',
          APNS_BUNDLE_ID: 'com.example.whale',
          APNS_PRIVATE_KEY_P8: key.pem,
          TEST_APNS_PUBLIC_JWK: key.publicJwk,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
})
