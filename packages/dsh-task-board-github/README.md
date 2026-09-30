# dsh-task-board-github — task board GitHub Issues provider extension

English | [中文](README.zh.md)

An external provider extension for the DSH Web GUI task board (`@linxin666/dsh-client-ui-task-board`). It owns the GitHub Issues side of the board: issues of the configured repositories are synchronized into board cards and follow the board's columns. The extension is enabled by default and can be switched off from its card under the Web GUI plugin settings. It is mounted through `cordis.patch.yml` and the profile mechanism and does not modify DSH source code.

## Features

- **GitHub Issues as an external board source**: every configured repository contributes its issues carrying the inclusion label; the board keeps owning the columns, execution and scheduling.
- **Per-repository configuration**: owner, repository, inclusion label, managed label prefix, the GitHub label behind each board column, the pull-request phase label, the poll interval, pull-request creation, the draft policy, close-on-merge and the pull-request base branch.
- **Controlled write-back**: only DSH-owned state and phase labels are added or removed. Repository labels, including the inclusion label itself, are never modified.
- **Execution immutability**: remote title and body refresh a card's content only until the card starts executing. The board's own content gate settles that, and the extension keeps no second opinion about which cards are frozen.
- **Deactivation without loss**: removing the inclusion label hides the card from the active board and keeps every execution; re-adding it restores the same card.
- **Seven model-visible tools**: the five synchronization tools (`task_board_github_list`, `task_board_github_get`, `task_board_github_refresh`, `task_board_github_create_pr`, `task_board_github_link_pr`) and two configuration tools (`task_board_github_setup`, `task_board_github_repositories`), contributed through the board's `registerTool` capability, so they follow the board's master switch AND this extension's switch.
- **Two board seats**: a task-detail section for the issue, its labels and its pull request, and a compact `#<issueNumber>` card decoration. The repository and credential summary renders in this extension's own settings card, beside the switches that govern it.
- **One switch gates both halves**: on by default. Turning it off stops polling, write-back, the event subscriptions and the tool registrations, clears the published summary and hides the seats — without remounting the row and without touching stored cards.
- **Board-owned registration, independent of load order**: the extension registers into the task board's provider surface and imports no task-board internals, so it builds, publishes and loads as a package of its own. Both halves wait for the board's service through a cordis dependency scope, so the board may activate before or after this row: the seats and the provider registration appear as soon as the service is served, and are released when it is withdrawn.
- **Host-side credential handling**: the token is resolved on the host — the harness credential store first (the same store the Models page writes API keys into), then the environment variable named by `tokenEnv`, then `GH_TOKEN`. The settings card and the setup tools write it once; no reply, snapshot or tool result carries its value. Remote issue text is stored as card content and provider metadata only; it never reaches a permission, a workspace identity or a `promptPrefix`.

## Install

Install the aggregate bundle or this package alone, then restart `dsh web`:

```sh
dsh plugin --profile web add @linxin666/dsh-client-ui-task-board-github@latest
```

For local development:

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)/packages/dsh-task-board-github
```

## Configure it in the GUI

Open the Web GUI settings and find the **GitHub Issues sync** card. Everything a normal setup needs is configured in place, with no profile patch and no restart:

1. **Paste a GitHub token** into the credential field and save it. The token goes to the local host once and is stored in the DSH credential store — the same store the Models page writes API keys into — and the browser never reads it back. A fine-grained token with repository read access (contents, issues and pull requests) is enough. A deployment that would rather keep the token out of the store can export `GITHUB_TOKEN` (or another name through `tokenEnv`) or `GH_TOKEN` instead; the card reports which source is in use and whether the store can be written at all.
2. **Add the repositories to synchronize**: type `owner/repo`, paste a GitHub URL or an SSH remote, and optionally name the inclusion label each repository uses. Only issues carrying that label become board cards.
3. **Test the connection**: the card reports the authenticated account and, per repository, whether it is reachable and how many open issues carry the inclusion label.

The same setup can be delegated to an agent: `task_board_github_setup` stores or clears the credential and runs the connection test, and `task_board_github_repositories` lists, adds, removes and updates repositories. A token passed as a tool argument becomes part of that conversation, so prefer the settings card where you can reach it.

## Configuration

| Key | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the extension; the settings card writes it in place and both halves follow it immediately. |
| `announceToAgent` | `false` | Opt-in: when true, the extension announces itself in agent system prompts. |
| `tokenEnv` | `GITHUB_TOKEN` | Credential reference the token is resolved under: the name it is stored under in the credential store, or the environment variable holding it. |
| `repositories` | `[]` | Repositories to synchronize, each with `owner`, `repository`, `inclusionLabel`, `managedLabelPrefix`, `stateLabels`, `prPhaseLabel`, `pollingIntervalMs`, `prCreationEnabled`, `draftPrPolicy`, `closeIssueOnMerge` and `baseBranch`. |

Every key is volatile, which is what lets the settings card, the setup tools and the profile patch all write it: a saved change reaches the running provider without remounting the row. The card itself renders the credential line, the repository list and the connection test; it reads them from this extension's own host routes, which answer loopback requests only. The read-only summary the running provider publishes (configured repositories and credential presence) still rides the board's own state channel and is what the card falls back to when the host routes are unreachable.

## Migrating from the task board row

Until the migration, the GitHub settings lived on the task board's own row as `githubTokenEnv` and `githubRepositories`. The task board no longer declares them: a profile that still carries them does not fail (the board's schema passes unknown keys through), but the values silently stop having any effect because nothing reads them any more.

Move both keys onto this package's row and rename them:

```yaml
- id: web-ui-task-board-github
  name: '@linxin666/dsh-client-ui-task-board-github'
  config:
    tokenEnv: GITHUB_TOKEN        # was githubTokenEnv on the task board row
    repositories:                  # was githubRepositories on the task board row
      - owner: deepseek-ai
        repository: dsh
        inclusionLabel: dsh
        prCreationEnabled: true
```

The switch defaults (`enabled: true`, `announceToAgent: false`) are the same on both rows.

## Known limitations

- A repository entry must name both `owner` and `repository`; an invalid entry fails the row's activation instead of silently skipping that repository.
- The extension only contributes while the task board is installed and enabled; on its own it configures GitHub access and nothing else.
- Turning the extension off does not delete board cards that were synchronized before, because the board owns its ledger.
- A repository whose poll interval is `0` is synchronized on demand only (a manual refresh, a status change or an execution settlement) and never on a timer.

## Build and test

Node 22.19 or newer and the official NPM SDK packages are required; no DSH source checkout is used.

```sh
pnpm --filter @linxin666/dsh-client-ui-task-board-github typecheck
pnpm --filter @linxin666/dsh-client-ui-task-board-github test
pnpm --filter @linxin666/dsh-client-ui-task-board-github build
```
