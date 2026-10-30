# team-hub

The team collaboration hub described by [PROTOCOL.md](PROTOCOL.md) (protocol
version 1.0.0). It owns the collaboration domain - issues, assignees,
collaboration status including in_review, comments, the activity stream,
decision questions and push notifications - while each DSH Host keeps authority
over execution.

It runs as one static Go binary with one SQLite file. [go/README.md](go/README.md)
owns the implementation: the package layout, the configuration table, the HTTP
surface, the lease state machine, the WebSocket behaviour and the build.

## Layout

| Path | Contents |
| --- | --- |
| `go/` | the service: `cmd/team-hub` plus `internal/hub` |
| `migrations/` | the schema of PROTOCOL.md section 3 and its additive objects, applied verbatim at startup |
| `contract/` | Host-facing request and response samples, shared with the plugin test suite |
| `PROTOCOL.md` | the frozen protocol contract, version 1.0.0 |

## Build, run, test

```sh
cd team-hub/go
go vet ./...
go test ./...
CGO_ENABLED=0 go build -trimpath -o team-hub ./cmd/team-hub
```

The database path, the listener, every credential and every optional feature is
an environment variable; [go/README.md#configuration](go/README.md#configuration)
lists them with the route each one closes when it is missing. A required setting
that is absent stops the process before anything listens.

## Deployment

One binary, one SQLite file, one environment file, one systemd unit. The process
speaks plain HTTP and listens on the loopback address; TLS terminates at the
reverse proxy in front of it. The unit, the proxy configuration, the data and
backup directories and the first-start sequence are in the
[self-host services handoff](../docs/archive/2026-10-30-selfhost-services-deployment-handoff.md).

Migrations are applied by the process itself, one transaction each, recorded in
the same `d1_migrations` ledger D1 used, so an existing database keeps its
migration position.

## First team and first admin

A hub with no team cannot be entered: sign-in only resolves members that already
exist, and inviting one needs an admin. `POST /api/v1/bootstrap` is the one call
that creates both, authorised by the `BOOTSTRAP_TOKEN` setting. Call it once
against the deployed hub with the email address of the person who will own it:

```sh
export BOOTSTRAP_TOKEN=<the value from the environment file>

curl -sS -X POST https://<hub-origin>/api/v1/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Team-Hub-Protocol-Version: 1.0.0' \
  -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" \
  -d '{"team_name": "DSH Team", "team_slug": "team-dsh", "email": "admin@example.com"}'
```

The hub resolves the email address to the account user id the schema needs and writes
the team and one active admin in a single transaction, answering `201`:

```json
{
  "team": { "id": "team_01j7b5w8m4f9q2e3r6t1y8u4i7", "name": "DSH Team", "slug": "team-dsh" },
  "member": { "id": "mem_01j7b5w8m4f9q2e3r6t1y8u4i8", "github_username": "account:acct_01j7b5w8m4f9q2e3r6t1y8u4id", "mention_handle": "admin", "account_user_id": "acct_01j7b5w8m4f9q2e3r6t1y8u4id", "role": "admin" }
}
```

That admin can sign in immediately and reach every admin endpoint: invite the
rest of the team through `POST /api/v1/teams/:teamId/members/invite`.

The call is a one-shot by construction, so there is no switch to turn off: the
endpoint only accepts a request while the teams table is empty, and every later
call answers `409 CONFLICT` with the id of the team that already exists.
Clearing the setting afterwards is optional; it turns the answer into
`503 NOT_CONFIGURED`.

| Answer | Meaning |
| --- | --- |
| `503 NOT_CONFIGURED` | `BOOTSTRAP_TOKEN`, `ACCOUNT_SERVICE_BASE` or `ACCOUNT_ADMIN_TOKEN` is not set on this process |
| `401 UNAUTHORIZED` | the `X-Bootstrap-Token` header is missing or does not match |
| `404 USER_NOT_FOUND` | the account service has no user with that email (sign in to the Whale app with Apple once first) |
| `409 CONFLICT` | the hub already has a team; bootstrap has already run |
| `502 ACCOUNT_UNAVAILABLE` | the account service is unreachable or returned an unexpected response |
| `201` | the team and its first admin were created |

## Sign-in

Two paths reach a member, and only one of them survives the transition.

**Account service (the destination).** `POST /auth/account { assertion }` is
the credential itself. The JWT is signed with ES256 by the account service, its
header names a `kid` that the JWKS at `ACCOUNT_JWKS_URL` publishes, and its
claims must name `ACCOUNT_ISSUER` as `iss`, `ACCOUNT_AUDIENCE` as `aud`, an
`exp` still ahead of the hub clock, and the account user id as `sub`. A verified
assertion opens the existing session pair (`access_token` / `refresh_token` /
`expires_in`) for the member whose `account_user_id` equals `sub`, and touches
that row's `updated_at`, which is the only last-seen timestamp the section 3
schema gives a member. It never creates a member: an account no member has bound
answers `409 NOT_LINKED`, every failed check answers `401 UNAUTHORIZED`, and a
JWKS document that cannot be fetched answers `502 ACCOUNT_UNAVAILABLE` (an
upstream fault, not a bad assertion).

**GitHub (the transition entry point).** `GET /auth/github/authorize`,
`GET /auth/github/callback` and `POST /auth/token` are unchanged, and a member
that signs in that way calls `POST /auth/account/link { assertion }` with their
hub session to bind `account_user_id`. An account another member already holds
is `409 IDENTITY_TAKEN`, repeating the same binding is a no-op, and a member
that already carries another account is `409 CONFLICT` - rebinding would
silently move an identity between people.

Retirement: once every member has bound an account, GitHub login leaves by
deleting those three routes, `POST /auth/account/link` and
[`go/internal/hub/github.go`](go/internal/hub/github.go). `/auth/refresh` and
`/auth/revoke` stay: they rotate and revoke a session, they do not mint an
identity. `members.github_user_id` and `members.github_username` outlive the
routes for now, because section 3 makes both `NOT NULL`; relaxing them is a
schema change of its own.

## Deviations from PROTOCOL.md

PROTOCOL.md is the frozen contract. These are the places where implementing it
needed something the document does not state, each kept additive and small.

1. **Storage the specification mandates without declaring.** `refresh_tokens`
   (section 2 rotation and revocation), `rate_limits` (section 11 quotas, which
   must survive a process restart), `oauth_states` (supplement A1.6: GitHub only
   echoes `state`, so the pending redirect target and PKCE challenge are held
   until the callback), and `comment_mentions` (supplement A1.5). Two additive
   `issues` columns store what sections 8.2 and 5 require but section 3 has no
   column for: `rework_instructions` and `failure_error`.
2. **Protocol header on browser navigations.** Section 1 requires
   `X-Team-Hub-Protocol-Version` on every REST request, but
   `GET /auth/github/authorize` and `GET /auth/github/callback` are reached by a
   browser navigation and a GitHub redirect, which cannot carry a custom header.
   Those two are exempt; every other route, and the WebSocket handshake through
   `protocol_version`, enforces the version.
3. **Human-driven transitions have no dedicated endpoints.** The state matrix
   (section 4) has submit-for-review, direct completion, retry and cancel, but
   the REST table (section 9) defines no endpoint for them; they are implemented
   as `PATCH /issues/:issueId { status }` and validated against the matrix.
4. **Settlement after a lapsed lease.** Section 5 tells a reconnecting Host to
   settle with its existing `execution_attempt_id`, and section 9 answers 412
   `LEASE_EXPIRED` for a settlement that misses the lease. The hub accepts the
   settlement when the presented attempt id matches the issue's current attempt
   (the reconnect write-back), and answers 412 otherwise. `settle` therefore
   accepts an optional `execution_attempt_id` field.
5. **Issue list filters.** Section 5.1 queries
   `?assignee_host_id=:hostId&status=assigned,waiting_host`, while section 9
   documents only `status` and `assignee`. Both are supported, `status` accepts a
   comma separated list, and a Host token is always restricted to its own agents.
6. **Member administration has no activity row.** Section 11 asks for an
   immutable audit record of every state change, but `activity.issue_id` is
   `NOT NULL REFERENCES issues(id)`, so invites and removals have no legal row
   in that table. Issue-scoped actions are all recorded; an invite writes one
   masked `[audit] member.joined` line to the process log instead, which is not
   durable (`team-hub/go/README.md` owns that gap).
7. **WebSocket violations close the socket.** Section 11 caps frames per
   connection and frame size, and the section 9 frame table has no error frame,
   so a violation closes the socket: `1008 RATE_LIMITED` or
   `1009 PAYLOAD_TOO_LARGE`.
8. **Two role rules resolve a clash inside the specification.** Section 11
   grants the review endpoints to any admin or member, so the hub additionally
   requires the reviewer or an admin; and the endpoint table lists question
   withdrawal as a Host operation while the section 11 matrix also grants it to
   admins, so the hub accepts the asking Host or an admin and refuses plain
   members.
9. **Supplements A1, A2 and A4.** `GET /api/v1/me`, the inbox, the team question
   list, the activity feed, `GET /api/v1/teams/:teamId/agents` and
   `comment_mentions` follow supplements A1 and A2 as frozen by the dispatcher:
   token responses carry `member`; `inbox`, `questions`, `activity`, `agents`
   and `me` reject Host tokens; the activity feed returns newest first with an
   activity id as the keyset cursor. Question and activity bodies are objects on
   the wire (`text`, `options[].label`, `answer.selected`/`answer.custom`,
   `actor_id`) while `options_json`, `answer_json` and `payload_json` remain
   their storage form; an answer needs a selection or a custom text. A revoked
   host reports `host_status: "offline"` because the wire shape has only two
   values.
10. **Supplement A4 (Host contract hardening).**
    - `POST /hosts/register` takes `{ hostname, client_version, agents: [{ name,
      preset_id, model?, reasoning_effort? }] }` with a mandatory `preset_id`,
      and answers `{ host_id, status, agents: [{ id, name }] }` so the Host can
      map its members to hub agent ids. `model` and `reasoning_effort` are kept
      on the agent row (`migrations/0003_a4_bindings.sql`) instead of dropped.
    - The WebSocket handshake authenticates from `Authorization: Bearer` only;
      a token in the query string is ignored and the connection is refused with
      401. The web session cookie still authenticates REST calls. The protocol
      version must arrive either as `protocol_version` or as
      `X-Team-Hub-Protocol-Version`, otherwise the handshake answers 400.
    - `expires_in` is seconds (7200 for the access token), in both the token
      response and the refresh response.
    - A claim is one conditional `UPDATE` guarded by
      `status IN ('assigned','waiting_host')` and the agent's host binding, so a
      race has exactly one winner; a reconnect is the second legal shape
      (`status='running'` with matching attempt and lease). `todo`, `failed`,
      `done`, `canceled` and `in_review` answer 422 `INVALID_STATE_TRANSITION`.
    - Pending rework is `rework_instructions` being non-null while the card is
      `assigned`; the hub never starts rework itself, and settlement clears the
      instructions because the run that consumed them is over.
    - `POST /auth/token` verifies the PKCE verifier against the stored
      `code_challenge` itself (S256) before GitHub is called, which is why the
      iOS callback records the authorization code on the pending authorization
      row instead of deleting it. The web flow binds `state` to the HttpOnly
      cookie `th_oauth_state` and writes `th_session` and `th_refresh` on the
      callback and on every refresh.
    - Submit-for-review and direct completion are limited to the assignee or an
      admin.
    - Host execution routes allow 120 requests per minute per host
      (supplement A4.6), not the 30 the section 11 table still shows.
11. **The invite row no longer contradicts the error-code table.** It used to
    list `400` among its status codes while its error codes were
    `USER_NOT_FOUND` and `ALREADY_MEMBER`, which the error-code table defines as
    `404` and `409`; the hub followed the error-code table, which is also what
    supplement A4.7 fixes. The email invite replaces that row, so `400` now
    belongs to it through `VALIDATION_FAILED`, and PROTOCOL.md carries the shape
    and the backward-incompatible note.
12. **The first team and its first admin have an endpoint of their own.**
    `POST /api/v1/bootstrap` is not in the section 9 table because a team that
    already exists never needs it: it exists so a deployment that has no team can
    be entered at all, since the callback only resolves members that already
    exist and the invite route needs an admin. It is gated by the
    `BOOTSTRAP_TOKEN` setting instead of a session, refuses with `409 CONFLICT`
    as soon as one team exists, and answers `503 NOT_CONFIGURED` while the
    setting is unset.
13. **APNs environment routing.** Delivery picks the Apple host from the
    registered token's `environment` column rather than the `APNS_BUNDLE_ID`
    setting, and the `apns-topic` header always carries the registered
    `bundle_id`, so a device registered for a different bundle is still
    addressed correctly.
14. **Account-service identity.** PROTOCOL.md defines session tokens the hub
    mints itself and no identity provider at all. `POST /auth/account` accepts a
    short-lived ES256 assertion signed by the account service
    (`ACCOUNT_JWKS_URL`, `ACCOUNT_ISSUER`, `ACCOUNT_AUDIENCE`), resolves the
    member whose `members.account_user_id` equals its `sub`, and issues the
    existing session pair; it refuses with `409 NOT_LINKED` rather than creating
    a member. `POST /auth/account/link` performs that binding from a session that
    entered through GitHub, which stays as the transition entry point. The only
    storage this adds is `members.account_user_id` with a partial unique index
    (`migrations/0004_account_identity.sql`), and a member's last-seen time is
    that row's `updated_at`.
