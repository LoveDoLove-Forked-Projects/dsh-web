# dsh-task-board-team · DSH 任务看板的团队协作提供方

[English](README.md) | 中文

面向 DeepSeek Harness (DSH) 任务看板（`@linxin666/dsh-client-ui-task-board`）的外部提供方扩展。它把本机接入云端 `team-hub`：hub 上指派给本机绑定的 dsh-agents 成员的 issue 会在租约下被领取、作为镜像卡在本机执行，执行结束后写回 hub；决策问题、评论与返工请求则在团队与该执行会话之间往返。看板的列、账本与执行规则零改动，插件经 `cordis.patch.yml` 与 profile 挂载，不修改任何 DSH 源码。

## 功能

- **按成员绑定，不是共享队列**：设置项填写 dsh-agents 成员 id，成员定义提供 hub 解析 @ 时使用的名字、Agent 预设与团队工作区。指派给其他 Agent 的 issue 即使被 hub 列出，本机也不会领取。
- **注册与心跳**：宿主启动时用主机名、客户端版本与 Agent 定义注册，随后每 15 秒心跳一次，这是协议固定的节奏。
- **带租约的领取**：领取会拿到租约令牌与执行 attempt id，镜像卡把两者存在本扩展自己的 `integrations` 载荷里，卡片执行期间每 20 秒续租。
- **幂等的重连**：重连会重新注册、按最后收到的序号续传事件通道，并用卡片已存的 attempt 凭证重新领取，因此识别该 attempt 的 hub 会重建租约而不是重复执行，也不会多建卡片或会话。
- **结算写回**：只有自动验收通过的执行记为 `succeeded`（issue 进入 `in_review`），失败或取消记为 `failed` 并附原因，摘要截断到协议规定的 4000 字符。
- **问题路由**：镜像卡会话里通过 `ask_user_question` 提出的决策问题会上报 hub，由该 issue 的审阅人回答；回答、过期或本地取消都会结束提问，本机其他会话仍由各自的应答方处理。
- **双向评论**：`team_comment` 工具让 Agent 在卡片对应的 issue 上发表评论，而 @ 到本机 Agent 的评论会作为后续消息投递进该卡片的会话。
- **审阅返工**：审阅被拒时先领取新的 attempt，成功之后才用审阅人的说明在既有会话里重跑该卡片；领取被拒则什么都不执行，只在本地记录这次拒绝。
- **可见的降级**：挂载时探测后续消息投递、返工与执行入口三项能力，缺少其中任何一项就失去对应的投递，并在卡片与设置区说明，其余功能照常工作。
- **三个浏览器席位**：任务详情区（issue、含 `in_review` 的 hub 状态、负责人、审阅人、评论线程、活动流与待答问题）、卡片上的 hub 状态徽标，以及看板自身设置卡内的配置区块——扩展关闭时该区块仍然可达。
- **一个开关同时收放两侧**：关闭扩展即停止领取轮询、租约定时器、事件通道与工具注册，清空已发布的摘要并撤下渲染席位，但不删除任何卡片。

## 安装

把本包装进 profile 后重启 `dsh web`：

```sh
dsh plugin --profile web add @linxin666/dsh-client-ui-task-board-team@latest
```

### 本地开发

```sh
pnpm install
pnpm --filter @linxin666/dsh-client-ui-task-board-team build
dsh plugin --profile web add link:$(pwd)/packages/dsh-task-board-team
```

## 配置

打开任务看板设置，找到「团队协作」区块：hub 地址与团队 id 存在本插件自己的 volatile 设置里，粘贴的 Host Token 只向宿主发送一次。

- Host Token 保存在 harness 凭据库的 `hostTokenRef` 名下（默认 `DSH_TEAM_HUB_TOKEN`），没有凭据库时读同名环境变量；快照、摘要与工具结果都不携带它的值。
- 成员绑定是 dsh-agents 成员 id（区块内用逗号分隔）。绑定的成员已不在 dsh-agents 账本里时，区块会报出来并跳过它。

```yaml
# 对应的 profile patch 写法
hubUrl: https://hub.example.com
teamId: team_01j7b5w8m4f9q2e3r6t1y8u4i5
hostTokenRef: DSH_TEAM_HUB_TOKEN
agents:
  - memberId: mem_01j7b5w8m4f9q2e3r6t1y8u4i6
```

## 已知限制

- **Agent 预设只记录、不钉住**：提供方契约的 `tasks.create` 草案没有预设字段，镜像卡把成员预设写进载荷并由设置区展示，实际执行沿用部署自身的默认值。
- **启动执行依赖看板的动作面**：契约没有「运行」能力，因此挂载时会探测看板的进程内动作应用器；部署不提供时，领取到的卡片被创建出来交由操作者自行启动。
- **活动流是本机观察到的事件**：协议没有活动查询端点，详情区渲染的是本宿主自启动以来从通道收到的事件。
- **问题逐个上报**：一次提问携带多个问题时只上报第一个，其余留在本机，因为 hub 的问题表存储单个问题。
- **被认领的问题最多持有两分钟**：超过该窗口，提问交回本地应答方并从 hub 撤回，这样即使团队始终不回答，会话也不会被拖到 hub 的 24 小时 TTL。

## 安全模型

- **Host Token 不会第二次到达浏览器**：它从设置区单向写入凭据库，只有宿主半区读取，之后只报告「已配置」与来源。
- **工具权限审批绝不进入 hub**：本提供方只订阅 `user-questions/request`，`approval/request` 在这里没有监听器，因此工具沙箱的决策留在本机，永远不会变成远端请求。
- **远端文本只是内容，不是权力**：issue 标题、正文或评论只会成为卡片文本、摘要字段或会话消息，绝不会变成权限、工作区身份、Agent 预设或 `promptPrefix`。
- **领取受租约约束**：本机无法镜像或无法启动的领取会被记录并任其过期，租约只在宿主仍持有它时续期。
