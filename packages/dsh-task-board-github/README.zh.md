# dsh-task-board-github — 任务看板 GitHub Issues 提供方扩展

[English](README.md) | 中文

DSH Web GUI 任务看板（`@linxin666/dsh-client-ui-task-board`）的外部提供方扩展。它承担看板的 GitHub Issues 一侧：配置仓库中的 issue 被同步为看板卡片，并跟随看板的列流转。扩展默认开启，可在 Web GUI 插件设置的本扩展卡片中关闭。它经 `cordis.patch.yml` 与 profile 机制挂载，不修改 DSH 源码。

## 功能

- **把 GitHub Issues 作为看板的外部来源**：每个已配置仓库中带纳入标签的 issue 都会成为看板卡片；列流转、执行与调度仍由看板负责。
- **按仓库配置**：owner、repository、纳入标签、自管标签前缀、每个看板列对应的 GitHub 标签、Pull Request 阶段标签、轮询间隔、是否允许创建 PR、草稿策略、合并后是否关闭 issue 以及 PR 目标分支。
- **总开关**：默认开启。该开关是 Web GUI 卡片就地写入的设置字段，关闭即撤下提供方，无需重挂载插件行。
- **登记面归看板所有**：扩展向看板的提供方席位登记，且不 import 看板内部实现，因此可作为独立包构建、发布与加载；在聚合包中它的行排在任务看板行之后，正是这个原因。
- **凭据只在 Host 侧处理**：GitHub 令牌由宿主半区从 `tokenEnv` 指定的环境变量读取，不会进入浏览器或 agent。

## 安装

安装聚合包或单独安装本包，然后重启 `dsh web`：

```sh
dsh plugin --profile web add @linxin666/dsh-client-ui-task-board-github@latest
```

本地开发：

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)/packages/dsh-task-board-github
```

## 配置

| 键 | 默认值 | 行为 |
| --- | --- | --- |
| `enabled` | `true` | 扩展总开关；设置卡就地写入该字段。 |
| `announceToAgent` | `false` | 需要时开启：开启后扩展向 agent 系统提示注入自身公告。 |
| `tokenEnv` | `GITHUB_TOKEN` | 存放 GitHub API 令牌的环境变量名。 |
| `repositories` | `[]` | 需要同步的仓库，每项含 `owner`、`repository`、`inclusionLabel`、`managedLabelPrefix`、`stateLabels`、`prPhaseLabel`、`pollingIntervalMs`、`prCreationEnabled`、`draftPrPolicy`、`closeIssueOnMerge` 与 `baseBranch`。 |

## 已知限制

- 本阶段交付包骨架、配置 schema 与设置开关；同步服务本身随提供方接入阶段登记，因此当前还不会同步任何 issue。
- 每条仓库配置必须同时给出 `owner` 与 `repository`；无效条目会让该行激活失败，而不是静默跳过该仓库。
- 扩展只在任务看板已安装且启用时才产生贡献；单独使用时它只配置 GitHub 访问，别无其它行为。
- 关闭扩展不会删除此前同步到看板的卡片，因为账本归看板所有。

## 构建与测试

需要 Node 22.19 或更高版本与官方 NPM SDK 包；不使用任何 DSH 源码 checkout。

```sh
pnpm --filter @linxin666/dsh-client-ui-task-board-github typecheck
pnpm --filter @linxin666/dsh-client-ui-task-board-github test
pnpm --filter @linxin666/dsh-client-ui-task-board-github build
```
