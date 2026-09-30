# dsh-task-board-github — 任务看板 GitHub Issues 提供方扩展

[English](README.md) | 中文

DSH Web GUI 任务看板（`@linxin666/dsh-client-ui-task-board`）的外部提供方扩展。它承担看板的 GitHub Issues 一侧：配置仓库中的 issue 被同步为看板卡片，并跟随看板的列流转。扩展默认开启，可在 Web GUI 插件设置的本扩展卡片中关闭。它经 `cordis.patch.yml` 与 profile 机制挂载，不修改 DSH 源码。

## 功能

- **把 GitHub Issues 作为看板的外部来源**：每个已配置仓库中带纳入标签的 issue 都会成为看板卡片；列流转、执行与调度仍由看板负责。
- **按仓库配置**：owner、repository、纳入标签、自管标签前缀、每个看板列对应的 GitHub 标签、Pull Request 阶段标签、轮询间隔、是否允许创建 PR、草稿策略、合并后是否关闭 issue 以及 PR 目标分支。
- **受控回写**：只增删 DSH 自有的状态与阶段标签；仓库自有标签（含纳入标签本身）绝不修改。
- **执行不可变**：远程标题与正文只在卡片开始执行之前刷新卡片内容。这一判定由看板自己的内容门禁裁定，扩展不再保留第二套“哪些卡片已冻结”的判定。
- **无损停用**：移除纳入标签会把卡片从活动看板隐藏，并保留全部执行记录；重新添加后恢复同一张卡片。
- **五个模型可见工具**：`task_board_github_list`、`task_board_github_get`、`task_board_github_refresh`、`task_board_github_create_pr`、`task_board_github_link_pr`，经看板的 `registerTool` 能力登记，因此随「看板总开关 × 本扩展开关」一起收放。
- **三个看板席位**：任务详情中的 issue / 标签 / Pull Request 区域；看板设置卡中的仓库与凭据摘要；以及紧凑的 `#<issueNumber>` 卡片徽章。
- **一个开关门禁两侧**：默认开启。关闭后即停止轮询、停止回写、解除事件订阅与工具登记、清空已发布摘要并撤下全部席位——无需重挂载插件行，也不触碰已存储的卡片。
- **登记面归看板所有**：扩展向看板的提供方席位登记，且不 import 看板内部实现，因此可作为独立包构建、发布与加载；在聚合包中它的行排在任务看板行之后，正是这个原因。
- **凭据只在 Host 侧处理**：GitHub 令牌由宿主半区从 `tokenEnv` 指定的环境变量读取，不会进入浏览器或 agent。远端 issue 文本只作为卡片内容与提供方元数据存储，绝不进入权限、工作区身份或 `promptPrefix`。

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
| `enabled` | `true` | 扩展总开关；设置卡就地写入该字段，两侧半区即时跟随。 |
| `announceToAgent` | `false` | 需要时开启：开启后扩展向 agent 系统提示注入自身公告。 |
| `tokenEnv` | `GITHUB_TOKEN` | 存放 GitHub API 令牌的环境变量名。 |
| `repositories` | `[]` | 需要同步的仓库，每项含 `owner`、`repository`、`inclusionLabel`、`managedLabelPrefix`、`stateLabels`、`prPhaseLabel`、`pollingIntervalMs`、`prCreationEnabled`、`draftPrPolicy`、`closeIssueOnMerge` 与 `baseBranch`。 |

设置卡还会显示已配置的仓库数量以及 Host 是否持有可用凭据。这份摘要由运行中的提供方发布，因此只在扩展开启时出现。

## 从看板行迁移

迁移之前，GitHub 相关设置位于任务看板自己的插件行上，键名为 `githubTokenEnv` 与 `githubRepositories`。任务看板已不再声明它们：仍携带这两个键的 profile 不会报错（看板 schema 对未知键透传），但取值会静默失效，因为已经没有代码读取它们。

请把两个键移到本扩展行并改名：

```yaml
- id: web-ui-task-board-github
  name: '@linxin666/dsh-client-ui-task-board-github'
  config:
    tokenEnv: GITHUB_TOKEN        # 原为看板行的 githubTokenEnv
    repositories:                  # 原为看板行的 githubRepositories
      - owner: deepseek-ai
        repository: dsh
        inclusionLabel: dsh
        prCreationEnabled: true
```

开关默认值（`enabled: true`、`announceToAgent: false`）两行一致。

## 已知限制

- 每条仓库配置必须同时给出 `owner` 与 `repository`；无效条目会让该行激活失败，而不是静默跳过该仓库。
- 扩展只在任务看板已安装且启用时才产生贡献；单独使用时它只配置 GitHub 访问，别无其它行为。
- 关闭扩展不会删除此前同步到看板的卡片，因为账本归看板所有。
- 轮询间隔为 `0` 的仓库只按需同步（手动刷新、列变化或执行结算），不会挂定时器。

## 构建与测试

需要 Node 22.19 或更高版本与官方 NPM SDK 包；不使用任何 DSH 源码 checkout。

```sh
pnpm --filter @linxin666/dsh-client-ui-task-board-github typecheck
pnpm --filter @linxin666/dsh-client-ui-task-board-github test
pnpm --filter @linxin666/dsh-client-ui-task-board-github build
```
