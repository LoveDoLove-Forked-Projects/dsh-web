# dsh-task-board-github — task board GitHub Issues provider extension

English | [中文](README.zh.md)

An external provider extension for the DSH Web GUI task board (`@linxin666/dsh-client-ui-task-board`). It owns the GitHub Issues side of the board: issues of the configured repositories are synchronized into board cards and follow the board's columns. The extension is enabled by default and can be switched off from its card under the Web GUI plugin settings. It is mounted through `cordis.patch.yml` and the profile mechanism and does not modify DSH source code.

## Features

- **GitHub Issues as an external board source**: every configured repository contributes its issues carrying the inclusion label; the board keeps owning the columns, execution and scheduling.
- **Per-repository configuration**: owner, repository, inclusion label, managed label prefix, the GitHub label behind each board column, the pull-request phase label, the poll interval, pull-request creation, the draft policy, close-on-merge and the pull-request base branch.
- **Controlled write-back**: only DSH-owned state and phase labels are added or removed. Repository labels, including the inclusion label itself, are never modified.
- **Execution immutability**: remote title and body refresh a card's content only until the card starts executing. The board's own content gate settles that, and the extension keeps no second opinion about which cards are frozen.
- **Deactivation without loss**: removing the inclusion label hides the card from the active board and keeps every execution; re-adding it restores the same card.
- **Five model-visible tools**: `task_board_github_list`, `task_board_github_get`, `task_board_github_refresh`, `task_board_github_create_pr` and `task_board_github_link_pr`, contributed through the board's `registerTool` capability, so they follow the board's master switch AND this extension's switch.
- **Three board seats**: a task-detail section for the issue, its labels and its pull request; a repository/credential summary in the board's settings card; and a compact `#<issueNumber>` card decoration.
- **One switch gates both halves**: on by default. Turning it off stops polling, write-back, the event subscriptions and the tool registrations, clears the published summary and hides the seats — without remounting the row and without touching stored cards.
- **Board-owned registration**: the extension registers into the task board's provider surface and imports no task-board internals, so it builds, publishes and loads as a package of its own. In the aggregate bundle its row is mounted after the task board's row for that reason.
- **Host-side credential handling**: the GitHub token is read from the environment variable named by `tokenEnv` by the host half and never reaches the browser or an agent. Remote issue text is stored as card content and provider metadata only; it never reaches a permission, a workspace identity or a `promptPrefix`.

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

## Configuration

| Key | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the extension; the settings card writes it in place and both halves follow it immediately. |
| `announceToAgent` | `false` | Opt-in: when true, the extension announces itself in agent system prompts. |
| `tokenEnv` | `GITHUB_TOKEN` | Environment variable holding the GitHub API token. |
| `repositories` | `[]` | Repositories to synchronize, each with `owner`, `repository`, `inclusionLabel`, `managedLabelPrefix`, `stateLabels`, `prPhaseLabel`, `pollingIntervalMs`, `prCreationEnabled`, `draftPrPolicy`, `closeIssueOnMerge` and `baseBranch`. |

The settings card also shows how many repositories are configured and whether the host holds a usable credential. That summary is published by the running provider, so it appears only while the extension is on.

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
