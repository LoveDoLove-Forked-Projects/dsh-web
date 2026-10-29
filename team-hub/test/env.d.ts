import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
  interface Env {
    /** Migration list the test environment carries; absent in production. */
    TEST_MIGRATIONS: D1Migration[]
    /** Public half of the APNs test key, so a test can verify a signed token. */
    TEST_APNS_PUBLIC_JWK: string
  }

  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
      TEST_APNS_PUBLIC_JWK: string
    }
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
    TEST_APNS_PUBLIC_JWK: string
  }
}

export {}
