# Agent Note: GitHub Issues as Task Board work items with controlled write-back

Status: implemented

## Problem

外部研发团队通常在 GitHub Issues 上追踪需求与可交付物，但此前使用本地 DSH 智能体执行这些任务需要在不同浏览器标签页间手动复制 Prompt 文本并同步状态。若在 GitHub 与自主智能体之间引入无约束的双向同步，将带来严重的安全与稳定性风险：不可信的外部 Issue 文本可能实施 Prompt 注入或提权会话权限，API 限流或网络故障可能导致正在运行的本地智能体执行中断，而不加控制的标签同步可能会覆盖用户的自有标签或导致意外关闭 Issue。

## Decision

在 DSH 任务看板中实现基于 Host 端的 GitHub Issue 同步机制，作为可选的外部提供方扩展（`packages/dsh-task-board-github`），数据载于看板不透明的 `TaskRecord.integrations` 容器中扩展自持的 `github` 键下：

- **入站发现**：两条通道任一命中即选中 issue——带配置的包含标签（默认 `dsh`），或被指派给该仓库配置的登录（`@me` 解析为宿主认证的账号）。选中的 issue 物化为本地任务卡片，或通过不可变身份三元组 `{ owner, repository, issueNumber }` 与既有卡片对齐；两条通道都不再命中时停用对应卡片。
- **本地权威状态机**：既有的五列看板状态机保持唯一权威。`running`（进行中）状态始终为 Host 本地状态。GitHub 状态标签（`dsh:state:*`）是对外状态投影，而非第二状态机。
- **受控回写**：回写操作仅严格增删 DSH 所属的状态与阶段标签（`dsh:state:*`、`dsh:phase:pr`）。无关的用户标签（如 `bug`、`security`、`priority:high` 以及包含标签本身）绝对不修改或删除。
- **执行不可变性**：远程 Issue 标题和正文仅在任务首次开启执行前刷新本地 Prompt 和描述。一旦执行尝试开始，远程变更仅作为只读元数据（`remoteTitle`、`remoteBody`）存储，不重写历史执行 Prompt。
- **无损停用**：移除包含标签仅将本地任务标记为停用并在活动看板中隐藏，保留所有历史执行记录。重新添加标签后通过相同身份恢复。
- **Host 端凭据与出站 HTTPS**：所有 GitHub API 请求均在 Host 端通过出站 HTTPS 发起（`api.github.com`）。Token 从 Host 环境变量或 profile patch 解析，绝不暴露给浏览器或智能体。
- **PR 完整生命周期与安全关闭**：自动创建 PR（默认关闭）或手动创建（`task_board_github_create_pr`）会先校验远程分支存在，再创建 PR、记录 PR 元数据并打上 `dsh:phase:pr` 标签。PR 合并后更新状态为 merged、清除 phase 标签、打上 done 标签，并在配置允许时关闭 Issue；未合入关闭的 PR 绝不关闭 Issue。
- **故障隔离**：GitHub 网络或接口错误仅在任务元数据中记录 `lastSyncError`，绝不中断或使本地正在执行的任务失败。
- **智能体工具与界面**：扩展经看板的 `registerTool` 能力提供七个受限工具，因此随「看板总开关 × 扩展 enabled」一起收放：五个同步工具（`task_board_github_list`、`task_board_github_get`、`task_board_github_refresh`、`task_board_github_create_pr`、`task_board_github_link_pr`）加两个配置工具——`task_board_github_setup`（凭据状态、存入、清除，以及一次真实连接测试）与 `task_board_github_repositories`（列出、添加、移除、修改仓库）。其浏览器半区遵循同一门禁：在任务详情中渲染 `data-dsh-part="github-integration"` 区域并渲染紧凑的 `#<issueNumber>` 卡片徽章，二者分别注册进看板声明的两个子席位（`task-board.detail.section`、`task-board.card.decoration`）。配置块（`data-dsh-part="github-settings"`）在扩展自己的设置卡中渲染，紧邻决定其行为的开关，且不占看板席位：它经本扩展自己的 loopback-only 配置路由访问宿主，人在界面上做的配置与模型通过两个配置工具做的配置走的是同一条路径。

## Architecture and Host-Side Security

所有 GitHub API 交互集中在扩展包 host 半区的 `GitHubApiClient` 与 `GitHubSyncService`（`packages/dsh-task-board-github/src/host/`）。扩展不 import 看板的任何模块：它在自己的 `src/core/contract.ts` 中同形重述提供方契约，并在运行时解析看板的 `taskBoard` 服务。凭据由宿主按固定顺序解析——先 DSH 凭据库（`ctx.credentials`，即 Models 页写入 API Key 的那个库），再 `tokenEnv` 指定的环境变量，最后 `GH_TOKEN`；令牌只经 `src/host/credentials.ts` 写入：设置卡与 `task_board_github_setup` 把令牌一次性 POST 到本扩展的 loopback-only 配置路由，由宿主存入，任何响应、快照或工具结果都不携带它的值。令牌绝不进入前端可观测的存储、设置命名空间，也不跨越 WebSocket/SSE 边界或进入模型可见载荷。远端不可变身份由扩展自己索引——启动时从看板已有卡片建立、并随看板上报的删除而清理；所有任务读写都经能力面（`tasks.*`、`integration.*`），只读发布状态随看板快照的 `extensions` 映射下发，看板始终是内容、列与事件的唯一权威。扩展行自己持有配置（`tokenEnv`、`repositories`）与两个开关（`enabled`、`announceToAgent`）；四个键都标记为 volatile，这正是设置卡、两个配置工具与 profile patch 都能经 `ctx.settings.mutate` 写入、且无需重挂载插件行就能到达运行中提供方的原因。不可信的 Issue 内容隔离在只读字符串元数据字段中，绝不隐式变更权限、工作区、交接包或 promptPrefix。

后台轮询使用独立的受限定时器（`HostTimerFace`），与现有的 5 秒会话名册心跳解耦，避免 API 配额耗尽并隔离外部网络抖动。

## Alternatives considered

曾考虑在 GitHub Issue 状态与任务看板列之间实现直接双向镜像（在 GitHub 变更状态直接驱动本地卡片移动，反之亦然）。该方案被否决，因为 DSH 本地任务执行对应真实的智能体运行时会话：外部标签变动不得随意中断或触发本地实际进程，且 GitHub 状态无法表达会话启动、队友生成等本地瞬态过程。

曾考虑将 GitHub 标签直接存储为卡片上的原生 `TaskTag` 对象。该方案被否决，因为 `TaskTag` 具有 8 标签上限且可能向智能体注入执行指令（`promptPrefix`）。将不可信的远程标签当作 prompt prefix 会使外部人员可通过添加 GitHub 标签操纵智能体执行行为，且大型标签集会超出 8 标签上限门禁。

曾考虑在浏览器前端使用用户提供的 Personal Access Token 直接调用 GitHub API。该方案被否决，因为在浏览器内存和前端包中暴露 Token 会造成安全泄漏隐患，且在关闭浏览器标签页时将无法执行后台轮询与定时任务联动。

曾考虑在本地任务执行成功后立即关闭 GitHub Issue。该方案被否决，因为本地代码生成或单测通过并不代表改动已评审或上线；行业规范流程是通过 PR 关联（"Fixes #123"），在 PR 合入后由平台原生关系或受控流程闭环。

## Consequences

- 研发团队可在 GitHub 上统一管理需求，同时无缝指派 DSH 智能体执行具体任务。
- 任务看板数据结构保持对非 GitHub 任务的完全向后兼容，无需账本 schema 迁移。
- GitHub 接口故障平滑降级为保留缓存状态并展示重试标记，不干扰正在运行的本地智能体。
- 凭据管理保持在服务端，需通过环境变量或 profile patch 部署，而非前端输入框。
