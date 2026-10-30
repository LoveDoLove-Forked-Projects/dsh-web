# team-hub self-hosted runtime

The team hub from `team-hub/` as a single Node process: Node 22, Hono,
better-sqlite3 and ws. It serves the same protocol (1.0.0) as the Cloudflare
Worker, with the same routes, request bodies, success shapes and UPPER_SNAKE
error codes, and the same lease state machine.

The protocol itself is not re-implemented here. `team-hub/src` keeps the router,
the auth modules and the domain modules; this service runs them against a
SQLite data layer instead of D1, and replaces the per-team Durable Object with
an in-process channel. A protocol change is still made once, in `team-hub/src`,
and both runtimes pick it up.

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | process entry: configuration report, startup, signal handling |
| `src/config.ts` | every environment setting, resolved and reported once |
| `src/db.ts` | SQLite handle and the D1 surface the shared modules expect |
| `src/migrations.ts` | applies `team-hub/migrations/*.sql`, reuses the same ledger table |
| `src/channel.ts` | per-team sequence, replay buffer, sockets and frame limits |
| `src/scheduler.ts` | the Worker cron replaced by a process timer |
| `src/server.ts` | Hono app, health routes, node:http listener, WebSocket upgrades |
| `test/` | the suite: real SQLite file, real HTTP, real WebSocket clients |

## Requirements

- Node 22 or newer.
- pnpm. `better-sqlite3` ships a native binding and `esbuild` unpacks a platform
  binary; both are allowed to run their install scripts by
  `selfhost/pnpm-workspace.yaml`.

## Install, run, test

```sh
cd team-hub/selfhost
pnpm install
pnpm build          # bundles src/main.ts and team-hub/src into dist/main.js
pnpm start          # node distilled/main.js, reads the environment below
pnpm test           # the suite in test/
pnpm typecheck      # tsc --noEmit, including the shared team-hub/src modules
```

`selfhost/pnpm-workspace.yaml` declares this directory as its own pnpm project
(`packages: ["."]`). pnpm discovers the nearest workspace file, so installs
here write `team-hub/selfhost/pnpm-lock.yaml` and never the repository root
`pnpm-lock.yaml` or `team-hub/pnpm-lock.yaml`. That pnpm lockfile is the only
one this package has.

`dist/` is generated and git-ignored.

## Configuration

Everything is an environment variable. Nothing has a fallback that silently
serves a half-configured hub.

| Variable | Default | Meaning when missing |
| --- | --- | --- |
| `DATABASE_PATH` | none | Required. The process refuses to start. |
| `HOST` | `127.0.0.1` | Loopback by default; TLS belongs to the reverse proxy. |
| `PORT` | `8080` | Invalid values refuse to start. |
| `TEAM_HUB_SIGNING_SECRET` | none | Required. HMAC key for session access tokens; without it no session can be signed or verified, so the process refuses to start. The name is the same secret the Worker reads. |
| `BOOTSTRAP_TOKEN` | none | `POST /api/v1/bootstrap` answers 503 `NOT_CONFIGURED`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | none | `GET /auth/github/*` and `POST /auth/token` answer 503 `NOT_CONFIGURED`. |
| `ACCOUNT_JWKS_URL` / `ACCOUNT_ISSUER` / `ACCOUNT_AUDIENCE` | none | `POST /auth/account` and `POST /auth/account/link` answer 503 `NOT_CONFIGURED`. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY_P8` | none | APNs delivery answers 503 `NOT_CONFIGURED`, as on the Worker. |
| `MIGRATIONS_DIR` | `team-hub/migrations` resolved from the module | Where the `.sql` files live. |
| `SWEEP_INTERVAL_MS` | `60000` | Sweep cadence; `0` keeps the startup sweep and disables the timer. |

The startup report is one line per setting group, for example:

```
[config] DATABASE_PATH=/var/lib/team-hub/hub.sqlite
[config] PORT=8080 HOST=127.0.0.1
[config] SESSION_SECRET...: configured
[config] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: missing -> GET /auth/github/* and POST /auth/token answer 503 NOT_CONFIGURED
[config] ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: missing -> POST /auth/account and /auth/account/link answer 503 NOT_CONFIGURED
[config] APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: missing -> APNs delivery answers 503 NOT_CONFIGURED
[config] BOOTSTRAP_TOKEN: configured
[config] SWEEP_INTERVAL_MS=60000 (sweep once at startup, then every 60000 ms)
[config] MIGRATIONS_DIR=/srv/team-hub/migrations
```

Secrets are never printed; only whether they are configured.

Behind the proxy, forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`.
The first two rebuild the request URL (absolute redirects and the OAuth origin
check depend on them); the last one is what the per-IP quota keys on, falling
back to `CF-Connecting-IP` and then `unknown`.

## HTTP surface

The route table is `team-hub/src/router.ts` verbatim: bootstrap, GitHub login
and token exchange, account assertion sign-in and link, members, hosts, issues,
claim / renew-lease / settle, reviews, comments, activity, questions, inbox,
push tokens and the team socket. The router's own rules come along unchanged:

- `X-Team-Hub-Protocol-Version` negotiation, with the WebSocket accepting
  `protocol_version` as a query parameter as well;
- the UPPER_SNAKE error envelope from `team-hub/src/errors.ts`, including
  `NOT_CONFIGURED`, `NOT_LINKED`, `LEASE_EXPIRED`, `LEASE_HELD_BY_OTHER` and
  `HOST_MISMATCH`;
- the section 11 quotas, now backed by the same SQLite file;
- team membership checks before a handler runs.

Two routes exist only here:

| Route | Answer |
| --- | --- |
| `GET /healthz` | 200 `{ status: "ok", service, protocol_version, uptime_ms }`; no dependency is claimed. |
| `GET /readyz` | 200 when the database answers and no migration is pending, 503 otherwise; lists applied/pending migrations and which features are configured. |

## WebSocket

`GET /api/v1/teams/:teamId/ws?protocol_version=1.0.0&since_seq=N` upgrades through
the same router path, so authentication is the ordinary `Authorization: Bearer`
header (member session token or Host token) and a token in the query string is
not accepted. The handshake then replays what the team's replay buffer still
holds after `since_seq`, or sends `resync_required` with `no_sequence`,
`sequence_ahead` or `sequence_too_old`. Frames, frame limits, the per-connection
quota, host-targeted events and `ping`/`pong` are the Durable Object's behaviour.

The sequence, buffer and sockets live in memory. A restart starts the sequence
at zero, so a client reconnecting with an old `since_seq` receives
`resync_required` and re-fetches the snapshot, which is the recovery path the
protocol already defines.

## Data and migrations

`src/db.ts` implements the D1 prepared-statement surface (`bind`, `first`,
`all`, `run`, `batch`, `exec`) over better-sqlite3, including
`meta.changes` and a transactional `batch`. Foreign keys are enforced, WAL is
on, and statements run synchronously on the event loop, which is what replaces
the Durable Object's per-team serialisation.

`src/migrations.ts` applies `team-hub/migrations/*.sql` in name order, one
transaction each, recording the name in `d1_migrations` — the same table D1
uses — so the schema is interchangeable with a Worker database.

## Process timer

The Worker's `* * * * *` cron becomes a `setInterval` on `SWEEP_INTERVAL_MS`
(60 s by default). One sweep runs before the port starts accepting traffic, then
on the timer: offline hosts after three missed heartbeats, lapsed leases back to
`waiting_host`, expired questions, and assigned cards waiting for an offline
host. A sweep in flight is never overlapped.

## Tests

`pnpm test` runs the suite against the real service: a temporary SQLite file on
disk, a real HTTP listener on an ephemeral loopback port, and real WebSocket
clients. GitHub, APNs and the account service are the same injected transport
seam the Worker suite uses.

Covered: registration and heartbeat, claim refusals (active lease, expired
lease, another host's agent), settlement idempotency, question routing,
assertion verification negatives and `NOT_LINKED`, WebSocket handshake
authentication and `since_seq` replay. The Worker suite under
`team-hub/test` is untouched and still runs against workerd.

## Differences from the Worker implementation

Deliberate and listed for review:

1. The route table, auth modules and domain modules are the Worker's own files,
   imported and bundled, not a second copy. Only the data layer, the channel,
   the process timer, configuration and the HTTP/WebSocket entry are new.
2. D1 becomes one local SQLite file through an adapter. Writes are synchronous
   on the event loop; there is no per-team Durable Object, no Redis, no lock.
3. The channel's sequence and replay buffer are in memory instead of Durable
   Object storage. After a restart clients resync; the protocol's recovery path
   covers it.
4. The cron trigger becomes `setInterval`, same one-minute cadence, plus one
   sweep before the listener opens.
5. `GET /healthz` and `GET /readyz` are new; the Worker had neither.
6. Missing GitHub settings close `/auth/github/*` and `/auth/token` with
   `NOT_CONFIGURED` instead of redirecting to GitHub with an empty client id.
   The other groups keep the Worker's own `NOT_CONFIGURED` behaviour.
7. The request URL is rebuilt from `Host` and `X-Forwarded-Proto`; quotas key on
   `X-Forwarded-For` or `CF-Connecting-IP`. Requests over 1 MiB are refused
   before routing with the same `PAYLOAD_TOO_LARGE` envelope (the protocol's
   own body cap remains 128 KiB).