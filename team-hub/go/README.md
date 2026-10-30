# team-hub (Go)

The team collaboration hub from `team-hub/` as one static Go binary: Go 1.23,
the standard library's `net/http` method-plus-path patterns,
`database/sql` with the pure-Go `modernc.org/sqlite` driver, `gorilla/websocket`
for the team channel, and `crypto/ecdsa` for account assertions and APNs
provider tokens. No cgo, no Node, no Cloudflare runtime.

It serves protocol 1.0.0: the routes, request bodies, success shapes and
UPPER_SNAKE error codes PROTOCOL.md defines, the lease state machine recorded in
the top-level README, and the same SQLite schema the D1 deployment used.

| Path | Responsibility |
| --- | --- |
| `cmd/team-hub/main.go` | process entry: configuration report, start, signal handling |
| `internal/hub/config.go` | every environment setting, resolved and reported once |
| `internal/hub/store.go` | the SQLite handle and the transaction helpers |
| `internal/hub/migrations.go` | applies `team-hub/migrations/*.sql` through the `d1_migrations` ledger |
| `internal/hub/errors.go` | the section 9 error envelope and the code-to-status table |
| `internal/hub/httpx.go` | JSON responses, version negotiation, body caps, field helpers |
| `internal/hub/ids.go` | typed prefixed identifiers, token hashes, UUIDs |
| `internal/hub/types.go` | row shapes, scans, and the wire views |
| `internal/hub/auth.go` | signed access tokens, rotating refresh tokens, Host tokens, quotas |
| `internal/hub/account.go` | account assertion verification, JWKS cache, sign-in and link |
| `internal/hub/account_admin.go` | the account-service admin lookup the email invite resolves through |
| `internal/hub/github.go` | GitHub OAuth authorize, callback, token exchange, PKCE |
| `internal/hub/members.go` | team, roster, invites, removal, bootstrap |
| `internal/hub/hosts.go` | Host tokens, registration, heartbeat, agent roster |
| `internal/hub/issues.go` | issue creation, listing, the human-driven matrix, reviews |
| `internal/hub/leases.go` | claim, renew-lease, settle, lease expiry |
| `internal/hub/questions.go` | ask, answer, withdraw, list, expiry |
| `internal/hub/comments.go` | comments and mention rows |
| `internal/hub/feeds.go` | activity feed and inbox |
| `internal/hub/sweep.go` | offline hosts, lapsed leases, expired questions |
| `internal/hub/channel.go` | per-team sequence, replay buffer, sockets and frame limits |
| `internal/hub/push.go` | APNs provider token and delivery |
| `internal/hub/routes.go` | the route table, auth policy, quotas, `/healthz` and `/readyz` |
| `internal/hub/handlers.go` | one function per route |
| `internal/hub/server.go` | listener, startup sweep, process timer, shutdown |

## Requirements

Go 1.23 or newer. The dependencies are pure Go, so the build needs no C
toolchain and the resulting binary has no cgo dependency.

## Build, run, test

```sh
cd team-hub/go
CGO_ENABLED=0 go build -trimpath -o team-hub ./cmd/team-hub
go test ./...
go vet ./...
```

Measured on this checkout:

```
darwin/arm64  CGO_ENABLED=0 -trimpath  15,975,058 bytes
linux/amd64   CGO_ENABLED=0 -trimpath  16,442,725 bytes (statically linked)
```

TLS is terminated by a reverse proxy; the process speaks plain HTTP and listens
on the loopback address by default.

## Configuration

Everything is an environment variable. Nothing has a fallback that silently
serves a half-configured hub: the settings that make the process unusable stop
it, and the rest close their own routes.

| Variable | Default | Meaning when missing |
| --- | --- | --- |
| `DATABASE_PATH` | none | Required. The process refuses to start. |
| `HOST` | `127.0.0.1` | Loopback by default; a non-loopback value is reported as a warning. |
| `PORT` | `8080` | Invalid values refuse to start. |
| `TEAM_HUB_SESSION_KEY` | none | Required. HMAC key for session access tokens. |
| `BOOTSTRAP_TOKEN` | none | `POST /api/v1/bootstrap` answers 503 `NOT_CONFIGURED`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | none | `GET /auth/github/*` and `POST /auth/token` answer 503 `NOT_CONFIGURED`. |
| `ACCOUNT_JWKS_URL` / `ACCOUNT_ISSUER` / `ACCOUNT_AUDIENCE` | none | `POST /auth/account` and `POST /auth/account/link` answer 503 `NOT_CONFIGURED`. |
| `ACCOUNT_SERVICE_BASE` / `ACCOUNT_ADMIN_TOKEN` | none | `POST /api/v1/teams/:teamId/members/invite` answers 503 `NOT_CONFIGURED` naming the setting that is absent; the route is the only caller of the account-service admin API. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY_P8` | none | `POST /api/v1/push-tokens` answers 503 `NOT_CONFIGURED`; delivery is skipped. |
| `MIGRATIONS_DIR` | `migrations` beside the working directory or the binary | Where the `.sql` files live. |
| `SWEEP_INTERVAL_MS` | `60000` | Sweep cadence; `0` keeps the startup sweep and disables the timer. |

The startup report is one line per setting group; secrets are never printed,
only whether they are configured:

```
[config] DATABASE_PATH=/var/lib/team-hub/hub.sqlite
[config] PORT=8080 HOST=127.0.0.1
[config] TEAM_HUB_SESSION_KEY: configured
[config] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: configured
[config] ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: missing -> POST /auth/account and /auth/account/link answer 503 NOT_CONFIGURED
[config] ACCOUNT_SERVICE_BASE/ACCOUNT_ADMIN_TOKEN: configured
[config] APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: missing -> APNs delivery is skipped and /readyz reports push=false
[config] BOOTSTRAP_TOKEN: configured
[config] SWEEP_INTERVAL_MS=60000 (sweep once at startup, then every 60000 ms)
[config] MIGRATIONS_DIR=/srv/team-hub/migrations
```

A missing required setting prints every error it found and exits non-zero before
anything listens.

Behind the proxy, forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`.
The first two rebuild the request origin (absolute redirects and the OAuth
origin check depend on them); the last one is what the per-IP quota keys on,
falling back to `CF-Connecting-IP` and then the socket address.

## HTTP surface

The route table is the one PROTOCOL.md section 9 defines, with these policies:

- `X-Team-Hub-Protocol-Version` negotiation, with the WebSocket accepting
  `protocol_version` as a query parameter as well;
- the UPPER_SNAKE error envelope, including `NOT_CONFIGURED`, `NOT_LINKED`,
  `LEASE_EXPIRED`, `LEASE_HELD_BY_OTHER` and `HOST_MISMATCH`;
- the section 11 quotas, backed by the same SQLite file;
- team membership checks before a handler runs.

| Route | Handler file |
| --- | --- |
| `GET /auth/github/authorize`, `GET /auth/github/callback`, `POST /auth/token` | `github.go`, `handlers.go` |
| `POST /auth/refresh`, `POST /auth/revoke` | `auth.go`, `handlers.go` |
| `POST /auth/account`, `POST /auth/account/link` | `account.go`, `handlers.go` |
| `POST /api/v1/bootstrap` | `members.go`, `handlers.go` |
| `GET /api/v1/me`, members, invites, removal | `members.go`, `handlers.go` |
| Host tokens, register, heartbeat, agents | `hosts.go`, `handlers.go` |
| Issues list, detail, create, patch, reviews | `issues.go`, `handlers.go` |
| claim, renew-lease, settle | `leases.go`, `handlers.go` |
| questions create, answer, withdraw, list | `questions.go`, `handlers.go` |
| comments, activity, inbox, mention read | `comments.go`, `feeds.go`, `handlers.go` |
| `GET /api/v1/teams/:teamId/ws` | `channel.go`, `handlers.go` |
| push tokens | `push.go`, `handlers.go` |

Two routes exist only here:

| Route | Answer |
| --- | --- |
| `GET /healthz` | 200 `{ status, service, protocol_version, uptime_ms }`; no dependency is claimed. |
| `GET /readyz` | 200 when the database answers and no migration is pending, 503 otherwise; lists applied/pending migrations and which features are configured. |

## Lease state machine

The lease state machine:

- `claim` is one conditional `UPDATE`; a card another attempt holds answers
  409 `LEASE_HELD_BY_OTHER` with the active `lease_expires_at`, a card whose
  agent belongs to another host answers 403 `HOST_MISMATCH`, and a card in any
  other status answers 422 `INVALID_STATE_TRANSITION`. Claim never answers
  `LEASE_EXPIRED`, not even for a lapsed lease.
- `renew-lease` is the only place an expired lease is refused: 412
  `LEASE_EXPIRED`, and the card steps back to `waiting_host`.
- `settle` is idempotent for the execution attempt that owns the card: the same
  attempt replays to the same answer without a second audit row, and an attempt
  the hub never minted for the run answers 412 `LEASE_EXPIRED`.

## WebSocket

`GET /api/v1/teams/:teamId/ws?protocol_version=1.0.0&since_seq=N` upgrades
through the same route table, so authentication is the ordinary
`Authorization: Bearer` header (member session token or Host token); a token in
the query string is not accepted. The handshake then replays what the team's
replay buffer still holds after `since_seq`, or sends `resync_required` with
`no_sequence`, `sequence_ahead` or `sequence_too_old`.

Frames, frame limits (64 KiB), the per-connection quota (60 frames per minute),
`ping`/`pong`, `resume` and host-targeted events are the channel's behaviour. The sequence, buffer and sockets live in memory: a restart starts the
sequence at zero, so a client reconnecting with an old `since_seq` receives
`resync_required` and re-fetches the snapshot, which is the recovery path the
protocol already defines.

## Data and migrations

`team-hub/migrations/*.sql` is applied verbatim, one transaction each, recorded
in the same `d1_migrations` table D1 uses, so the schema is interchangeable with
a Worker database. Foreign keys are enforced, WAL is on, and the process owns one
SQLite connection, which serialises writes.

Member administration is audited only in the process log. Section 11 asks for an
immutable audit record of every state change, but `activity.issue_id` is
`NOT NULL REFERENCES issues(id)`, so an invite or a removal has no legal row in
that table; the top-level README records the same deviation. An invite writes one
line instead:

```
[audit] member.joined team=team_... member=mem_... account=acct_... role=member actor=mem_... email=a***@example.com
```

The local part of the address is masked, so the full address never enters a log.
That line is the only trace: it is not queryable, and it is gone after a restart or
a rotated log file, so it is not durable. Durable member-administration audit
needs a new team-scoped table - `activity` cannot carry it without rebuilding the
table to accept a NULL `issue_id` - and is deliberately not attempted here.

## Process timer

The Worker's `* * * * *` cron becomes a ticker on `SWEEP_INTERVAL_MS` (60 s by
default). One sweep runs before the port starts accepting traffic, then on the
timer: offline hosts after three missed heartbeats, lapsed leases back to
`waiting_host`, expired questions, and assigned cards waiting for an offline
host. A sweep in flight is never overlapped.

## Tests

`go test ./...` runs the suite against the real service: a temporary SQLite file
on disk, a real HTTP listener on an ephemeral loopback port, and real WebSocket
clients. GitHub, the account service and APNs are one injected transport.

Covered: registration and heartbeat (including name conflicts and dropped
agents), the three claim refusals plus concurrent claims having one winner,
renewal expiry stepping the card back, settlement idempotency and the foreign
attempt refusal, failed settlements and retries, question routing, answering and
withdrawal rules, question expiry by sweep and by the process timer, offline
hosts and their leases, five assertion negatives with real P-256 signatures,
`NOT_LINKED`, the three link rules, the closed-route `NOT_CONFIGURED` answers,
four WebSocket handshake refusals, all three resync reasons, `since_seq` replay,
live delivery, `ping`/`pong`, the `resume` frame, host-targeted delivery, and the
three frame-limit closes.

## Porting notes

Deliberate divergences, recorded here because they are choices a reader of the
protocol would otherwise re-open:

1. This is a second implementation, not the Worker's modules bundled: the Go
   code restates the routes, domain rules and error table. The contract samples in
   `team-hub/contract/` and the protocol stay the source of truth.
2. D1 becomes one local SQLite file through `database/sql`; the per-team Durable
   Object becomes an in-process channel. The sequence and replay buffer are in
   memory, so a restart makes clients resync.
3. The cron trigger becomes a ticker, same one-minute cadence, plus one sweep
   before the listener opens.
4. `GET /healthz` and `GET /readyz` are new; the Worker had neither.
5. Missing GitHub settings close `/auth/github/*` and `/auth/token` with
   `NOT_CONFIGURED` instead of redirecting to GitHub with an empty client id.
6. `POST /api/v1/push-tokens` answers 503 `NOT_CONFIGURED` on a hub without an
   APNs credential (the Worker stores the token regardless), and a failed
   delivery is logged rather than failing the request that triggered it.
7. The JWKS document is cached for five minutes by key id, and refetched when an
   assertion names a kid the cache does not hold; the Worker fetches per
   verification.
8. A request whose path exists only under another method answers 404
   `NOT_FOUND` like any unmatched path, where `net/http` would answer 405.
9. `X-Forwarded-Proto` / `Host` rebuild the request origin, and
   `X-Forwarded-For` (then `CF-Connecting-IP`, then the socket address) is what
   the per-IP quota keys on.
