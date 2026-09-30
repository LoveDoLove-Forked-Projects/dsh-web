# dsh-task-board-github — task board GitHub Issues provider extension

English | [中文](README.zh.md)

An external provider extension for the DSH Web GUI task board (`@linxin666/dsh-client-ui-task-board`). It owns the GitHub Issues side of the board: issues of the configured repositories are synchronized into board cards and follow the board's columns. The extension is enabled by default and can be switched off from its card under the Web GUI plugin settings. It is mounted through `cordis.patch.yml` and the profile mechanism and does not modify DSH source code.

## Features

- **GitHub Issues as an external board source**: every configured repository contributes its issues carrying the inclusion label; the board keeps owning the columns, execution and scheduling.
- **Per-repository configuration**: owner, repository, inclusion label, managed label prefix, the GitHub label behind each board column, the pull-request phase label, the poll interval, pull-request creation, the draft policy, close-on-merge and the pull-request base branch.
- **Master switch**: on by default. The switch is a settings field the Web GUI card writes in place, so turning it off withdraws the provider without remounting the row.
- **Board-owned registration**: the extension registers into the task board's provider surface and imports no task-board internals, so it builds, publishes and loads as a package of its own. In the aggregate bundle its row is mounted after the task board's row for that reason.
- **Host-side credential handling**: the GitHub token is read from the environment variable named by `tokenEnv` by the host half and never reaches the browser or an agent.

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
| `enabled` | `true` | Master switch for the extension; the settings card writes it in place. |
| `announceToAgent` | `false` | Opt-in: when true, the extension announces itself in agent system prompts. |
| `tokenEnv` | `GITHUB_TOKEN` | Environment variable holding the GitHub API token. |
| `repositories` | `[]` | Repositories to synchronize, each with `owner`, `repository`, `inclusionLabel`, `managedLabelPrefix`, `stateLabels`, `prPhaseLabel`, `pollingIntervalMs`, `prCreationEnabled`, `draftPrPolicy`, `closeIssueOnMerge` and `baseBranch`. |

## Known limitations

- This stage ships the package skeleton, the configuration schema and the settings switch. The synchronization service itself is registered with the provider migration, so no issue is synchronized yet.
- A repository entry must name both `owner` and `repository`; an invalid entry fails the row's activation instead of silently skipping that repository.
- The extension only contributes while the task board is installed and enabled; on its own it configures GitHub access and nothing else.
- Turning the extension off does not delete board cards that were synchronized before, because the board owns its ledger.

## Build and test

Node 22.19 or newer and the official NPM SDK packages are required; no DSH source checkout is used.

```sh
pnpm --filter @linxin666/dsh-client-ui-task-board-github typecheck
pnpm --filter @linxin666/dsh-client-ui-task-board-github test
pnpm --filter @linxin666/dsh-client-ui-task-board-github build
```
