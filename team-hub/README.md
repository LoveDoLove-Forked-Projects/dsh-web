# team-hub

Cloudflare Worker that implements the team collaboration hub described by
[PROTOCOL.md](PROTOCOL.md) (protocol version 1.0.0). It owns the collaboration
domain - issues, assignees, collaboration status including in_review, comments,
the activity stream, decision questions and push notifications - while each DSH
Host keeps authority over execution.

Nothing in this directory has been deployed. The deployment inputs below are the
only things needed to turn it into a running hub, and every one of them is
supplied by the operator.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Worker entry: request boundary, error envelope, cron sweep |
| `src/router.ts` | Route table, protocol version gate, role matrix, quotas |
| `src/auth/` | GitHub OAuth (Web code flow and iOS PKCE), session and Host tokens |
| `src/domain/` | Issues, leases, questions, comments, inbox, hosts, members, sweep |
| `src/durable/team-channel.ts` | One Durable Object per team: sequence, replay buffer, sockets |
| `src/push/apns.ts` | APNs provider JWT (ES256, cached 50 minutes) and delivery |
| `src/constants.ts` | Every numeric value of PROTOCOL.md section 13 and the section 11 caps |
| `migrations/` | D1 schema: section 3 verbatim, plus the additive objects listed below |
| `test/` | Behaviour tests on the Workers local runtime (workerd, real D1, real Durable Objects) |

## Local development

`team-hub` is its own pnpm project and is deliberately not a member of the
repository's pnpm workspace, so installing here never touches the root lockfile
or the plugin packages.

```sh
cd team-hub
pnpm install
pnpm test        # vitest on @cloudflare/vitest-pool-workers (workerd, real D1/DO)
pnpm typecheck   # tsc --noEmit
pnpm types       # regenerate worker-configuration.d.ts from wrangler.jsonc
```

Outbound HTTP to GitHub and APNs is injected through the environment in tests
(`TEAM_HUB_OUTBOUND`), so the suite never reaches the network.

## Deployment prerequisites

Everything below must be provided before the first deploy. No value is stored
in this repository.

### 1. D1 database

```sh
cf d1 create dsh-team-hub          # or: wrangler d1 create dsh-team-hub
```

Put the returned id into `wrangler.jsonc` at
`d1_databases[0].database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
Apply the schema to the created database:

```sh
wrangler d1 migrations apply dsh-team-hub --remote
```

### 2. GitHub OAuth App

Create an OAuth App and supply:

| Setting | Value |
| --- | --- |
| Client ID | the app's client id, stored as `GITHUB_CLIENT_ID` |
| Client secret | stored as `GITHUB_CLIENT_SECRET` |
| Authorization callback URL | `https://<hub-domain>/auth/github/callback` |

### 3. APNs provider key

Apple Developer account inputs:

| Input | Worker secret |
| --- | --- |
| `.p8` private key (Key ID shown next to it) | `APNS_PRIVATE_KEY_P8` |
| 10-character Key ID | `APNS_KEY_ID` |
| 10-character Team ID | `APNS_TEAM_ID` |
| App bundle identifier | `APNS_BUNDLE_ID` |

The key is only ever read from the environment secret; no copy belongs in this
repository or in `wrangler.jsonc`.

### 4. Hub signing key

`TEAM_HUB_SIGNING_SECRET` is an HMAC key the hub uses to sign OAuth state and
session access tokens. Generate one, for example `openssl rand -hex 32`.

### 5. Secrets

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put TEAM_HUB_SIGNING_SECRET
wrangler secret put APNS_KEY_ID
wrangler secret put APNS_TEAM_ID
wrangler secret put APNS_BUNDLE_ID
wrangler secret put APNS_PRIVATE_KEY_P8
```

## Deviations from PROTOCOL.md

PROTOCOL.md is the frozen contract. These are the places where implementing it
needed something the document does not state, each kept additive and small.

1. **Storage the specification mandates without declaring.** `refresh_tokens`
   (section 2 rotation and revocation), `rate_limits` (section 11 quotas, which
   must survive Worker isolates), `oauth_states` (supplement A1.6: GitHub only
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
   in that table. Issue-scoped actions are all recorded.
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
11. **One contradiction left in the specification text.** The endpoint table's
    invite row still lists `400` among its status codes while its error codes are
    `USER_NOT_FOUND` and `ALREADY_MEMBER`, which the error-code table defines as
    `404` and `409`. The hub follows the error-code table, which is also what
    supplement A4.7 fixes. PROTOCOL.md is maintained by the protocol owner and is
    not edited here.
10. **APNs environment routing.** Delivery picks the Apple host from the
    registered token's `environment` column rather than the `APNS_BUNDLE_ID`
    secret, and the `apns-topic` header always carries the registered
    `bundle_id`, so a device registered for a different bundle is still
    addressed correctly.