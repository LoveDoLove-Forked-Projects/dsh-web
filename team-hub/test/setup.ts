import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'

// This plugin build carries no automatic per-test storage isolation, so the
// suite does it explicitly: every test starts from an empty database with the
// PROTOCOL.md section 3 schema freshly applied. Dropping in reverse dependency
// order keeps the foreign keys satisfied.
const TABLES = [
  'comment_mentions',
  'rate_limits',
  'oauth_states',
  'refresh_tokens',
  'push_tokens',
  'questions',
  'activity',
  'comments',
  'issues',
  'agents',
  'hosts',
  'members',
  'teams',
  'd1_migrations',
]

beforeEach(async () => {
  for (const table of TABLES) {
    await env.DB.prepare('DROP TABLE IF EXISTS ' + table).run()
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
