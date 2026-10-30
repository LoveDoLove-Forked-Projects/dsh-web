# 任务看板 × 团队协作交付总结

本文档记录任务看板与团队协作集成链路的当前交付状态、验证边界、上线前置依赖与已知风险。

## 一、交付范围与各面现状

### 1. 云端中枢 team-hub
云端中枢是一个 Go 服务加一个 SQLite 文件，监听 loopback、由 systemd 保活、由反向代理终止 TLS。服务对外通信遵循 §PROTOCOL.md§ 1.0.0 规范；§contract/§ 目录下维护一套标准请求与响应样例文件，由插件的假中枢与测试套件读取以保证契约一致；§POST /api/v1/bootstrap§ 端点仅在系统内尚未存在任何团队时允许调用，通过比对请求头 §X-Bootstrap-Token§ 与 §BOOTSTRAP_TOKEN§ 环境变量实施鉴权。实现与配置见 [team-hub/go/README.md](../../team-hub/go/README.md)。

### 2. Host 插件 packages/dsh-task-board-team
Host 侧插件完整实现「认领 → 建镜像卡 → 执行 → 自动验收 → settle 回写 hub」的状态机循环；认领任务后在本地任务看板自动创建镜像卡，并将团队协作元数据写入镜像卡的 `integrations[task-board-team]` 载荷（字段包含 `issueId`、`issueNumber`、`attemptId`、`leaseToken`、`leaseExpiresAt`、`agentId` 与 `hubStatus`）；插件在认领前执行工作区闸门校验，工作区路径按优先级解析：配置项 `workspaceId` → 关联 agent 绑定的 `team.workspaceId` → 空；若最终解析结果为空则拒绝认领任务，仅在宿主侧输出一条可见的问题提示。

### 3. 看板扩展契约与出站投影
第三方扩展写入 `integrations` 载荷的机密凭据严格保留在宿主本地台账，绝不出站；任务看板的投影广播层在向外部客户端推送快照前执行递归敏感键剥除，按整键比对并移除 `leaseToken`、`lease_token`、`token`、`secret`、`password`、`apiKey` 与 `credential`，过滤逻辑覆盖任意数据深度；宿主本地数据存储保持原始数据不变，依赖相关凭据的扩展由主机侧直接读取本地台账。

### 4. iOS Whale App
客户端中 Tasks、Squads 与 Team 三个页签呈现为同一张底层任务卡在不同工作流视角的三个镜头；客户端与 hub issue 的权威关联键以卡片内 `integrations` 载荷为准，Prompt 首行携带的元信息仅作为兜底匹配；全 App 界面内的相对时间展示统一锁定为英文，由 `RemoteKit RelativeTime` 模块驱动；核心命名定义完成固化：Squad 代表花名册（包含 lead、成员列表与对应预设，属于 DSH 官方领域对象），Agent 为花名册中的独立执行个体，Team 代表云端中枢上人类与智能体共同协作的空间。

### 5. 身份统一
账号服务（`Server/`）已完成前两阶段建设：新增 GitHub 登录支持与 `identities` 关联表，用户与单一来源身份解耦，`users` 表原有 `apple_sub` 字段已删除并完成建表重建，存量历史身份在迁移过程中已全量预先回填至 `identities` 表；账号服务负责为 team-hub 签发基于 ES256 算法的短期身份断言 JWT（有效期 300 秒，`iss` 取固定的 `ACCOUNT_SERVICE_ORIGIN` 配置值，公钥通过 `/v1/keys` JWKS 端点发布）；team-hub 提供 `POST /auth/account` 端点验证该断言并换发自身业务会话；hub 的 `members` 表新增可空的 `account_user_id` 字段及部分唯一索引，当账号未绑定成员记录时返回 `409 NOT_LINKED` 错误且绝不隐式自动创建成员，过渡期通过 `POST /auth/account/link` 端点由用户主动绑定，既有 GitHub 直接登录端点继续保留待后续退役。

## 二、已验证状态与未验证边界

### 1. 已验证通过路径
线上真实设备端到端链路已闭环跑通：在 D1 数据库中直接创建 issue 记录 → Host 插件轮询认领（issue 状态成功变更为 `running`，生成对应 attempt 记录并追加 activity 日志）→ 宿主自动创建镜像卡 → 任务在宿主环境执行成功 → 触发自动验收流程并通过 → 执行 settle 操作回写 hub → hub 侧 issue 状态变更为 `in_review`（累计记录 3 条 activity 日志）。

### 2. 未验证项
- `in_review` 状态经由人工审批（approve）流转至 `done` 的完整流程尚未执行（该操作依赖有效的成员登录会话）。
- 镜像卡在真机宿主上的全自动拉起启动尚未在线上真机验证（线上运行的构建当前仍属于旧版本，需重启 DSH 宿主服务并补齐 `workspaceId` 配置后方可恢复自动调度）。
- GitHub 真实 OAuth 鉴权往返链路未走线上验证（测试阶段使用本地模拟 GitHub 服务执行用例）。
- 账号服务短期断言签发与 team-hub 验签置换会话的流程目前仅在本地自动化测试中验证通过，尚未部署至线上运行环境。

## 三、上线前必须执行的操作步骤

系统上线前必须按以下严格拓扑顺序执行三步操作，必须保证账号服务部署就绪并对外提供服务后，team-hub 方可开放访问：

1. 部署账号服务，在生产环境中配置 `ACCOUNT_ASSERTION_KEY_JWK`（P-256 私钥 JWK，必须包含 `kid` 标识）以及 `GITHUB_CLIENT_ID` 与 `GITHUB_CLIENT_SECRET`。
2. 对账号服务的数据库执行迁移：二进制在监听端口之前自行应用 §Server/migrations/*.sql§，没有独立的迁移命令。
3. 在 team-hub 配置 §ACCOUNT_JWKS_URL§、§ACCOUNT_ISSUER§ 与 §ACCOUNT_AUDIENCE§ 环境变量；§migrations/0004_account_identity.sql§ 由 hub 启动时自行应用，随后拉起 hub 进程。

## 四、已知风险与未处理项

- 看板全量快照向所有连接客户端广播卡片时，会将每张卡的 `integrations` 载荷原样转发；除上述敏感凭据字段已被剥除外，第三方扩展写入的大段数据（单张卡实测超过 4KB）会一并下发，当前尚未建立数据体积硬上限或出站字段白名单收窄机制。
- team-hub 的 `POST /auth/account` 接口响应中未写入会话 Cookie，实现与既有 `POST /auth/token` 保持同形；Web GUI 后续若在浏览器环境中直接调用该端点，需要服务端补齐 `Set-Cookie` 逻辑。
- team-hub 在处理每次登录鉴权请求时均实时向 JWKS 端点拉取最新公钥，当前未对公钥集做内存缓存或本地存储。
- 账号服务短期断言的 `iss` 字段存在运维耦合成本，后续若变更域名需要同步调整账号服务配置与 team-hub 环境变量两处；该说明已在 `Server/README` 记录，但在架构决策记录中尚未重申。
- iOS 客户端当前无法获得执行宿主的显示名称（hub 仅向下游下发 `host_id` 与 `host_status`），执行宿主在界面上仍直接展示为原始 ID 字符串。
- 任务卡详情页副标题中的租约有效时间描述（"lease ends in …"）缺失真机渲染证据：线上唯一携带该载荷的历史卡片租约已严重过期，且其镜像 issue 在真实 hub 中并不存在；尝试通过本地 DEBUG fixture 注入数据补齐证据时，当前开发机上的 WhaleUITests runner 连续三次在同一位置失败（DTX 握手交接阶段 socket 被断开，runner 无法拉取 IDE 配置后返回退出码 74），尝试切换 USB 物理直连亦未恢复；鉴于同一设备在 2026-10-28 曾成功通过 UI 测试用例，该现象属于开发机环境通信层面的间歇性故障；测试用的 fixture 载荷与调试用例已按约定完整撤回，仓库内未残留任何失败的 UI 测试。
- 开发机环境限制：macOS 环境未提供 §setsid§ 工具，通过 §launchctl submit§ 提交的后台作业在退出后会周期性重新执行，调试完成后需要通过 §launchctl remove§ 显式移除。

## 五、命名与术语规范

为防止后续开发与协作概念混淆，团队相关术语严格界定如下：
- Squad：DSH 官方领域对象，对应 `squads_list` 接口返回的数据模型，由 Lead 角色、成员列表及预设配置构成。
- Agent：花名册（Squad）中承担执行角色的个体。
- Team：云端中枢（team-hub）上由人类用户与智能体共同协作的独立空间。
三者在用户界面、通信协议与代码逻辑中各自指代不同层级的概念，严禁相互替代或混用。
