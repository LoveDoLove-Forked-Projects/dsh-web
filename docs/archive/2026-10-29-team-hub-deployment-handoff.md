# Team hub deployment handoff

Written 2026-10-29 after the hub was deployed, the local profile was prepared, and the end-to-end flow was verified to in_review. Everything below is a fact about the running deployment, not a proposal.

## The hub

- URL: `https://dsh-team-hub.1090093659.workers.dev`
- Worker name: `dsh-team-hub`; D1 database `dsh-team-hub` (`add4f9cc-163a-4eac-90d7-91663d1b6d10`), three migrations applied
- Durable Object class `TeamChannelDO` (SQLite), created on the first deploy; cron `* * * * *`
- Secrets present: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TEAM_HUB_SESSION_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_P8`
- `BOOTSTRAP_TOKEN` is deliberately unset: a team already exists, so `POST /api/v1/bootstrap` answers 503 and the endpoint stays closed. Set it only on a hub that has no team yet.
- Deployment tool is `cf` (`team-hub/cloudflare.config.ts`); `cf deploy --secrets-file <file>` carries the secrets in one version.

## Network caveat

`*.workers.dev` is not reachable with `curl` directly from this machine (Clash routes it direct and the TLS handshake is reset), but Node's native `fetch` reaches it fine, which is what the DSH Host plugin uses. To probe with curl, go through the local proxy: `curl -x http://127.0.0.1:7890 ...`.

A custom domain on `dsh-market.com` is not available: that zone answers every hostname at any depth from the market Worker, so a Worker custom domain there never receives the request.

## Team and identity

- Team: `team_dsh` / name `DSH Team` / slug `dsh-team`, seeded by hand into D1.
- Admin: `mem_owner`, GitHub login `zhu1090093659`, numeric id `46916148`, role `admin`, status `active`, written by hand into D1.
- GitHub OAuth App: `DSH Team Hub`, client id `Ov23liog2PFEleoU9k3v`, callback `https://dsh-team-hub.1090093659.workers.dev/auth/github/callback`.

## Local Host and agents

- Local Host: `host_zclmac`, token located at `/tmp/team-hub-secrets/host_token` (72 characters), `token_hash` stored in D1.
- Host status: `online`, `client_version` `0.4.12`, registered 4 agents (`xundong` / 寻冬, `michun` / 觅春, `zhixia` / 知夏, `luoqiu` / 落秋, each with its own preset).

## Verification status

- End-to-end flow verified to `in_review`: creating an issue -> Host claims (transitions to `running` + attempt + activity logged) -> automatically creates mirror card -> execution succeeds -> automated acceptance passes -> settle -> transitions to `in_review`.
- The unverified segment is `in_review` -> human approve -> `done`, which requires an authenticated member session.
- Mirror card automatic start depends on a run workspace; the current running build on the host is an earlier version, requiring a DSH restart with `workspaceId` configured (or setting `team.workspaceId` on the `dsh-agents` team) to restore automatic execution.

## Process management caveats

- macOS has no `setsid`; scripts started with `nohup` are swept when the host process group is reaped.
- Jobs submitted via `launchctl submit` execute repeatedly and must be removed with `launchctl remove` when finished.

## What is mounted

`~/.dsh/profiles/desktop/cordis.patch.yml` carries a row `web-ui-task-board-team` naming `@linxin666/dsh-client-ui-task-board-team`; the package is linked into `~/.dsh/profiles/node_modules/@linxin666/` by `node scripts/link-profile.mjs`. The profile patch was backed up as `cordis.patch.yml.bak-team-1793285796` before the row was added.

## Remaining work

1. Restart the DSH host and configure `workspaceId` (or set `team.workspaceId` on the `dsh-agents` team) so mirror cards auto-start.
2. Verify the final segment: `in_review` -> human approve -> `done` via a member session.

## Gap recorded, not fixed

A hub with no team cannot be entered: the GitHub callback only resolves members that already exist, and inviting one needs an admin. `POST /api/v1/bootstrap` closes that loop for future hubs; this deployment was seeded by hand before that endpoint existed.
