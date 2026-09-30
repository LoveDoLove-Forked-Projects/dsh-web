# dsh-task-board-github — 任务看板 GitHub Issues 提供方扩展

[English](README.md) | 中文

DSH Web GUI 任务看板（`@linxin666/dsh-client-ui-task-board`）的外部提供方扩展。它承担看板的 GitHub Issues 一侧：配置仓库中的 issue 被同步为看板卡片，并跟随看板的列流转。扩展默认开启，可在 Web GUI 插件设置的本扩展卡片中关闭。它经 `cordis.patch.yml` 与 profile 机制挂载，不修改 DSH 源码。

## 功能

- **把 GitHub Issues 作为看板的外部来源**：每个已配置仓库中带纳入标签的 issue 都会成为看板卡片；列流转、执行与调度仍由看板负责。
- **按仓库配置**：owner、repository、纳入标签、自管标签前缀、每个看板列对应的 GitHub 标签、Pull Request 阶段标签、轮询间隔、是否允许创建 PR、草稿策略、合并后是否关闭 issue 以及 PR 目标分支。
- **受控回写**：只增删 DSH 自有的状态与阶段标签；仓库自有标签（含纳入标签本身）绝不修改。
- **执行不可变**：远程标题与正文只在卡片开始执行之前刷新卡片内容。这一判定由看板自己的内容门禁裁定，扩展不再保留第二套“哪些卡片已冻结”的判定。
- **无损停用**：移除纳入标签会把卡片从活动看板隐藏，并保留全部执行记录；重新添加后恢复同一张卡片。
- **七个模型可见工具**：五个同步工具（`task_board_github_list`、`task_board_github_get`、`task_board_github_refresh`、`task_board_github_create_pr`、`task_board_github_link_pr`）加两个配置工具（`task_board_github_setup`、`task_board_github_repositories`），经看板的 `registerTool` 能力登记，因此随「看板总开关 × 本扩展开关」一起收放。
- **两个看板席位**：任务详情中的 issue / 标签 / Pull Request 区域，以及紧凑的 `#<issueNumber>` 卡片徽章。仓库与凭据摘要改在本扩展自己的设置卡中渲染，紧邻决定其行为的开关。
- **一个开关门禁两侧**：默认开启。关闭后即停止轮询、停止回写、解除事件订阅与工具登记、清空已发布摘要并撤下全部席位——无需重挂载插件行，也不触碰已存储的卡片。
- **登记面归看板所有，且与加载顺序无关**：扩展向看板的提供方席位登记，且不 import 看板内部实现，因此可作为独立包构建、发布与加载。两侧半区都经 cordis 依赖作用域等待看板的提供方服务，因此看板先于或后于本插件行激活都可以：服务一被提供，席位与 provider 登记就出现；服务撤走即自动释放。
- **凭据只在 Host 侧处理**：令牌由宿主解析——先查 DSH 凭据库（与 Models 页存 API Key 是同一处），再查 `tokenEnv` 指定的环境变量，最后查 `GH_TOKEN`。设置卡与配置工具只写入一次，任何响应、快照或工具结果都不携带令牌值。远端 issue 文本只作为卡片内容与提供方元数据存储，绝不进入权限、工作区身份或 `promptPrefix`。

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

## 在界面里配置

打开 Web GUI 设置页，找到 **GitHub Issues 同步** 卡片。常规配置全部在卡片里完成，不用改 profile patch，也不用重启：

1. **粘贴 GitHub Token** 并保存。令牌只发给本机宿主一次，存进 DSH 凭据库（与 Models 页存 API Key 是同一处），浏览器不会读回；一个只有仓库读权限（contents / issues / pull requests）的 fine-grained token 就够用。如果不想把令牌放进凭据库，也可以改用环境变量：`tokenEnv` 指定的变量名（默认 `GITHUB_TOKEN`）或 `GH_TOKEN`；卡片会显示当前用的是哪种来源，以及凭据库是否可写。
2. **添加要同步的仓库**：输入 `owner/repo`，或直接粘贴 GitHub 链接 / SSH 远程地址，并可顺便指定该仓库使用的纳入标签。只有带该标签的 issue 才会成为看板卡片。
3. **测试连接**：卡片会报告认证到的账号，并逐个仓库给出是否可达、有多少个带纳入标签的 open issue。

也可以把这件事交给 agent：`task_board_github_setup` 负责存取/清除凭据并跑连接测试，`task_board_github_repositories` 负责列出、添加、移除与修改仓库。注意：作为工具参数传入的令牌会成为该次会话记录的一部分，能打开设置卡时优先用设置卡。

## 配置

| 键 | 默认值 | 行为 |
| --- | --- | --- |
| `enabled` | `true` | 扩展总开关；设置卡就地写入该字段，两侧半区即时跟随。 |
| `announceToAgent` | `false` | 需要时开启：开启后扩展向 agent 系统提示注入自身公告。 |
| `tokenEnv` | `GITHUB_TOKEN` | 令牌解析所用的凭据引用名：凭据库里的存储名，或存放它的环境变量名。 |
| `repositories` | `[]` | 需要同步的仓库，每项含 `owner`、`repository`、`inclusionLabel`、`managedLabelPrefix`、`stateLabels`、`prPhaseLabel`、`pollingIntervalMs`、`prCreationEnabled`、`draftPrPolicy`、`closeIssueOnMerge` 与 `baseBranch`。 |

四个键都是 volatile 字段，这正是设置卡、配置工具与 profile patch 都能写入它们的原因：保存后的改动无需重挂载插件行就能到达正在运行的提供方。卡片自身渲染凭据状态、仓库列表与连接测试，数据来自本扩展自己的宿主路由，而这些路由只服务 loopback 请求。运行中的提供方仍会把只读摘要（已配置仓库与凭据有无）发布到看板状态通道，卡片在宿主路由不可达时回退到它。

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
