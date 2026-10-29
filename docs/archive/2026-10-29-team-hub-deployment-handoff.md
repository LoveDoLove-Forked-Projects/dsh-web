# Team hub deployment handoff

Written 2026-10-29 after the hub was deployed and the local profile was prepared. Everything below is a fact about the running deployment, not a proposal.

## The hub

- URL: `https://dsh-team-hub.1090093659.workers.dev`
- Worker name: `dsh-team-hub`; D1 database `dsh-team-hub` (`add4f9cc-163a-4eac-90d7-91663d1b6d10`), three migrations applied
- Durable Object class `TeamChannelDO` (SQLite), created on the first deploy; cron `* * * * *`
- Secrets present: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TEAM_HUB_SIGNING_SECRET`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_P8`
- `BOOTSTRAP_TOKEN` is deliberately unset: a team already exists, so `POST /api/v1/bootstrap` answers 503 and the endpoint stays closed. Set it only on a hub that has no team yet.
- Deployment tool is `cf` (`team-hub/cloudflare.config.ts`); `cf deploy --secrets-file <file>` carries the secrets in one version.

## Network caveat

`*.workers.dev` is not reachable with `curl` from this machine (Clash sends it direct and the TLS handshake is reset), but Node's `fetch` reaches it fine, which is what the DSH Host plugin uses. To probe with curl, go through the local proxy: `curl -x http://127.0.0.1:7890 ...`.

A custom domain on `dsh-market.com` is not available: that zone answers every hostname at any depth from the market Worker, so a Worker custom domain there never receives the request.

## Team and identity

- Team: `team_dsh` / name `DSH Team` / slug `dsh-team` — seeded by hand, because a hub with no team has no way in (see "Gap" below)
- Admin: `mem_owner`, GitHub login `zhu1090093659`, numeric id `46916148`, role `admin`, status `active`
- GitHub OAuth App: `DSH Team Hub`, client id `Ov23liog2PFEleoU9k3v`, callback `https://dsh-team-hub.1090093659.workers.dev/auth/github/callback`

## What is mounted

`~/.dsh/profiles/desktop/cordis.patch.yml` carries a row `web-ui-task-board-team` naming `@linxin666/dsh-client-ui-task-board-team`; the package is linked into `~/.dsh/profiles/node_modules/@linxin666/` by `node scripts/link-profile.mjs`. The profile patch was backed up as `cordis.patch.yml.bak-team-1793285796` before the row was added.

## Remaining work

1. Restart the host so the new row mounts.
2. Sign in with GitHub from the Web GUI (or the Whale app) and confirm the account resolves as the `team_dsh` admin.
3. Mint a Host Token as that admin, then paste the hub URL and the token into the task board's team settings block.
4. Run the two-Host end-to-end acceptance, capture the Web GUI screenshots, move the proposal note to `implemented/`, and write the delivery summary.

## Gap recorded, not fixed

A hub with no team cannot be entered: the GitHub callback only resolves members that already exist, and inviting one needs an admin. `POST /api/v1/bootstrap` closes that loop for future hubs; this deployment was seeded by hand before that endpoint existed.
