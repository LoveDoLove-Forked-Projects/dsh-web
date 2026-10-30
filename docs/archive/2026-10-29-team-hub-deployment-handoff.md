# Team hub deployment handoff

Written 2026-10-29 for the hub this repository shipped at the time, rewritten for the Go service that answers the same protocol. Everything below is a fact about the running deployment, not a proposal. The Worker deployment this document first recorded is in git history.

## The hub

- URL: `https://hub.chatwithai.icu`, TLS terminated by the host nginx, the process itself on `127.0.0.1:18788`
- Binary: `/opt/whale-go/hub/team-hub`, built with `CGO_ENABLED=0 go build -trimpath` from `team-hub/go`; systemd unit `team-hub.service`, `EnvironmentFile=/etc/whale/team-hub.env`
- Storage: one SQLite file addressed by `DATABASE_PATH`; the four migrations in `team-hub/migrations/` are applied by the process before it listens, recorded in the `d1_migrations` ledger
- Settings present in the environment file: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TEAM_HUB_SESSION_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_P8`, `ACCOUNT_JWKS_URL`, `ACCOUNT_ISSUER`, `ACCOUNT_AUDIENCE`
- `BOOTSTRAP_TOKEN` is deliberately unset: a team already exists, so `POST /api/v1/bootstrap` answers 503 and the endpoint stays closed. Set it only on a hub that has no team yet.
- `SWEEP_INTERVAL_MS` keeps the default 60 seconds: one sweep runs before the listener opens, then on the timer.

The implementation, the configuration table and the HTTP surface are in [team-hub/go/README.md](../../team-hub/go/README.md); the unit, the proxy block and the first-start sequence are in the [self-host services handoff](2026-10-30-selfhost-services-deployment-handoff.md).

## Network

nginx owns `443` for `hub.chatwithai.icu` and forwards to `127.0.0.1:18788` with `Host`, `X-Forwarded-Proto` and `X-Forwarded-For` set. The WebSocket route under `/api/v1/teams/` needs the `Upgrade` and `Connection` headers and a long `proxy_read_timeout`, or clients reconnect every minute. The per-IP quota keys on `X-Forwarded-For`, falling back to `CF-Connecting-IP` and then the socket address, so a proxy that drops the header collapses every client onto one bucket.

## Team and identity

- Team: `team_dsh` / name `DSH Team` / slug `dsh-team`, seeded by hand into the database.
- Admin: `mem_owner`, GitHub login `zhu1090093659`, numeric id `46916148`, role `admin`, status `active`, written by hand into the database.
- GitHub OAuth App: `DSH Team Hub`, client id `Ov23liog2PFEleoU9k3v`, callback `https://hub.chatwithai.icu/auth/github/callback`.

## Local Host and agents

- Local Host: `host_zclmac`, token located at `/tmp/team-hub-secrets/host_token` (72 characters), `token_hash` stored in the hub database.
- Host status: `online`, `client_version` `0.4.12`, registered 4 agents (`xundong` / 寻冬, `michun` / 觅春, `zhixia` / 知夏, `luoqiu` / 落秋, each with its own preset).

## Verification status

- End-to-end flow verified to `in_review`: creating an issue -> Host claims (transitions to `running` + attempt + activity logged) -> automatically creates mirror card -> execution succeeds -> automated acceptance passes -> settle -> transitions to `in_review`.
- The unverified segment is `in_review` -> human approve -> `done`, which requires an authenticated member session.
- Mirror card automatic start depends on a run workspace; the running build on the host is an earlier version, requiring a DSH restart with `workspaceId` configured (or setting `team.workspaceId` on the `dsh-agents` team) to restore automatic execution.

## Process management caveats

- macOS has no `setsid`; scripts started with `nohup` are swept when the host process group is reaped.
- Jobs submitted via `launchctl submit` execute repeatedly and must be removed with `launchctl remove` when finished.

## What is mounted

`~/.dsh/profiles/desktop/cordis.patch.yml` carries a row `web-ui-task-board-team` naming `@linxin666/dsh-client-ui-task-board-team`; the package is linked into `~/.dsh/profiles/node_modules/@linxin666/` by `node scripts/link-profile.mjs`. The profile patch was backed up as `cordis.patch.yml.bak-team-1793285796` before the row was added.

## Remaining work

1. Restart the DSH host and configure `workspaceId` (or set `team.workspaceId` on the `dsh-agents` team) so mirror cards auto-start.
2. Verify the final segment: `in_review` -> human approve -> `done` via a member session.

## Gap recorded, not fixed

A hub with no team cannot be entered: the callback only resolves members that already exist, and inviting one needs an admin. `POST /api/v1/bootstrap` closes that loop for future hubs; this deployment was seeded by hand before that endpoint existed.
