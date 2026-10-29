# Agent Note: Team collaboration extension for the task board

Status: proposed

## Problem

DSH 任务看板是单机、单写入者的 Host 账本，没有「人」这个概念。remote-bridge（[remote bridge protocol v1](../../implemented/architecture/2026-10-16-remote-bridge-protocol-v1.zh.md)）的每台配对设备对应一条公钥记录，所有调用都以同一个 owner peer 的身份发出；看板只有执行记录上的 `initiatedBy`，没有负责人。在 2 到 5 人的小团队里，每个人都有自己的 DSH 和 Agent，但缺少一个共享的协作面，让 human team 和 Agent team 能互相分派、求助、审阅。参考对象是 Linear。

## Proposal

1. **拓扑**：多台 Host 加一个云端中枢 team-hub。team-hub 是一个独立的 Cloudflare Worker（和 market/worker 分开），数据持久化用 D1，每个团队一个 Durable Object，负责实时 WebSocket 推送和串行写入。schema 支持多团队，第一期只部署一个团队。
2. **分权**：team-hub 是协作字段的权威（issue、负责人、协作状态，含 in_review、评论、活动流、待答问题）；执行这张卡的 Host 是执行权威（会话、执行、自动验收）。新插件 `@linxin666/dsh-task-board-team`（`packages/dsh-task-board-team`）按看板扩展契约（[task board extension contract](../../implemented/architecture/2026-09-30-task-board-extension-contract.zh.md)）做第二个外部 provider，看板核心的列和账本都不变。本地卡片通过 `integrations` 不透明载荷镜像 hub 上的 issue，执行结果再回写到 hub。
3. **身份**：人类成员用 GitHub OAuth 登录（Web 和 iOS），管理员按 GitHub 用户名邀请成员；每台 Host 用管理员签发的 Host Token 注册成一个执行节点。
4. **负责人**：负责人可以是人，也可以是 Agent。每个 Agent 成员（来自 dsh-agents 的成员定义）绑定在某位人类成员的 Host 上，由这台 Host 领取并带租约执行。Host 离线时卡片保持「等待执行节点」，不转移给别的 Host。
5. **求助路由**：`ask_user_question` 类的决策问题，以及「卡住、需要输入」的信号，经 hub 推给卡片的人类负责人或审阅人；工具权限审批只给执行这张卡的 Host 的主人。多处都能回答时，以第一个回答为准。Host 侧做法：像 remote-bridge 的 approvals/questions（[remote bridge protocol v1](../../implemented/architecture/2026-10-16-remote-bridge-protocol-v1.zh.md)）一样加入进程内的 approval 瀑布，只认领与团队卡关联的会话里的「问题」，不认领权限审批。
6. **人审**：看板自动验收通过之后，hub 状态进入 `in_review`，审阅人通过后才进入 Done；打回时，评论作为返工指令，在同一个会话里重新跑（`reuseSession`）。本地看板列保持原有的封闭集合，`in_review` 只存在于 hub。
7. **评论**：`@` 某个 Agent 的评论，作为后续消息投递进它的执行会话；Agent 通过新工具 `team_comment`（用扩展契约的 `registerTool` 注册）发评论。所有活动都记入 hub 的活动流。
8. **iOS**：Whale App（仓库 `~/code/iphone_remote_use_dsh` 下的 Remote 工程）是人类成员的主入口，负责收件箱、指派、评论、审阅和回答问题。它直连 team-hub（HTTPS + WebSocket，GitHub 登录），推送由 Worker 直接调 APNs。原来经 Tailscale 和 bridge 直连自己 Host 的通道保留，用于看会话、批权限。
9. **第一期不做**：Project、Cycle、Triage、估点等规划层不纳入第一期交付范围。

## Context & Efficiency Impact

方案新增一个工具 `team_comment`，带一段简短的 schema。问题和评论以后续消息的形式进入会话，会按条增加上下文。看板快照只多一份不透明的 `integrations` 条目（每份不超过 64 KiB）。

## Contract gaps

现有扩展契约（`packages/dsh-task-board/src/core/extension.ts`，`TASK_BOARD_API_VERSION = 1`，[task board extension contract](../../implemented/architecture/2026-09-30-task-board-extension-contract.zh.md)）提供 `tasks.{list, get, create, patchContent, setStatus, linked}`、`integration.{read, write}`、`events.{onStatusChanged, onExecutionSettled, onTaskDeleted}`、`publish`、`registerTool`、`handleAction`，但缺两项能力：(a) 向卡片当前或最近一次执行会话投递后续消息；(b) 带返工指令、复用会话重跑一张已执行过的卡。已执行卡片的内容按 `canEditTaskContent` 冻结，所以不能用 `patchContent` 代替。提议用「可选、增量」的方式扩展契约，`apiVersion` 保持 1，只针对 v1 构建的 provider 不受影响。这个方案需要看板所有者在 M0 评审确认。

## Milestones

- **M0 契约增量**：在 `dsh-task-board` 里加上 `followUp` 和 `rework` 两项可选能力，配契约测试。
- **M1 team-hub**：先产出 hub 协议规格（REST、WS 事件、D1 schema：`teams`、`members`、`hosts`、`agents`（绑定 host）、`issues`、`comments`、`activity`、`questions`、`push_tokens`），然后实现 GitHub OAuth、Host Token、DO 推送、租约、APNs。代码目录 `team-hub/`，和 `market/` 并列。
- **M2 dsh-task-board-team 插件**：host 半边负责 hub 客户端、issue 到卡片的镜像（只镜像绑定在本机的 Agent 的卡）、续租、执行结算回写、`team_comment`、问题路由、`@` 评论投递、返工；client 半边负责设置区（hub 地址、Host Token、Agent 绑定）、详情区（负责人、评论、活动流）、卡片装饰。依赖 M0 和 M1 的协议规格。
- **M3 Whale iOS**：GitHub 登录、收件箱、issue 列表和详情、指派、评论、审阅通过或打回、回答问题、APNs 注册。依赖 M1。
- **M4 两台 Host 端到端验收与发布准备**：两台 Host 的端到端验收，以及 README 三件套、aggregate、publish-prep 等发布准备。

M0 和 M1 可以并行；M2 和 M3 在 M1 的协议规格冻结之后可以并行。

## Alternatives considered

**共享单台 Host**：被拒，因为团队成员需要在各自机器上用各自的仓库、本地配置和 API Key 跑 Agent；单台共享 Host 无法满足不同成员的本地开发环境与专属配置需求。

**每台 Host 用 CRDT 复制完整账本**：被拒，因为这需要重构看板账本结构、编写复杂的冲突合并逻辑，会打破保证本地确定性一致性的单写入者不变量。

**在线 Host 池化抢单**：被拒，因为不同机器之间的执行环境（依赖、工具链、代码检出）差异巨大，且任务被任意在线节点抢占会导致 API 费用归属模糊。

**允许队友审批工具权限**：被拒，因为工具执行直接作用于本地机器及其沙箱环境与宿主访问；允许远端队友审批本地工具权限越过了本机执行的安全边界。

**邀请码加设备密钥的自建身份**：被拒，因为自建身份需要从零实现账户恢复、设备注销与多设备身份同步逻辑，不仅带来额外维护负担，安全性相比 GitHub OAuth 也没有优势。

**可自部署的 Node 服务**：被拒，因为同时维护 Node.js 服务端技术栈与边缘无服务器部署会带来双重运行时维护开销；统一到 Cloudflare Worker、D1 和 Durable Object 能保持运维脚手架单一。

**人审取代自动验收**：被拒，因为这会迫使人类审阅者去检查每一次原始运行和琐碎产出，丧失了自动化契约与目标验收闸门带来的提效优势。

**评论只在人之间流转**：被拒，因为这会失去人与 Agent 协同的交互落点；把 `@` 评论作为后续消息投递给 Agent，并让 Agent 能够发评论，是人机协作闭环的核心。

## Acceptance criteria

- 2 位成员、2 台 Host 跑通端到端：成员 A 在 Whale iOS App 上建卡，指派给 B 机器上的 Agent。
- B 的 Host 领取并带租约执行。
- Agent 用 `team_comment` 提问，A 从锁屏推送进入并回答。
- 看板自动验收通过后进入 `in_review`。
- A 打回审阅并附带评论；同一会话返工（`reuseSession`）。
- 再次自动验收通过后，A 审阅通过，卡片进入 Done。
- 全程事件、提问、评论与状态流转均记入 hub 活动流。
- 工具权限审批从不出现在 A 的设备上（严格归属 B 的 Host 主人）。
- B 离线时卡片显示「等待执行节点」，不发生跨机器迁移。
- 看板核心代码不出现团队相关的词汇（在 `packages/dsh-task-board` 中执行 `grep` 验证无相关词汇）。
- 仓库合并门禁全部通过（`CI checks`、`plugin-mount`、`Validate PR contribution evidence`、`guard-agent-notes`）。

## Risks

- APNs 需要 Apple 开发者账号和 `.p8` 密钥的托管（作为 Worker secret）。
- 租约过期和 Host 重连时可能发生重复执行。
- GitHub OAuth 在 iOS 上的回调方案（自定义 URL scheme 或 Universal Links）。
- hub 宕机时的降级表现（本地 Host 执行不受影响，团队协作功能暂停）。
- 后续消息以追加形式注入会话带来的额外 token 消耗。
- 契约增量（`followUp` 与 `rework`）需要看板所有者在 M0 评审确认。
