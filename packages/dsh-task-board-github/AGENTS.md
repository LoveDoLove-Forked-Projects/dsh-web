# AGENTS.md — dsh-task-board-github

任务看板的外部提供方扩展（GitHub Issues 同步）。本文件只写本包特有规则。

## 与看板的边界

- 本包是 `packages/dsh-task-board` 的外部提供方：它不 import 看板的任何
  `src/**` 内部实现，跨包协作只走看板的提供方契约（cordis 服务），由看板
  侧拥有登记面。契约的唯一事实源是看板的 `src/core/extension.ts`；本包在
  `src/core/contract.ts` 同形重述它，两侧半区都经 `ctx.inject(['taskBoard'], ...)`
  的依赖作用域取得能力面（host 半区 `registerExtension`，浏览器半区客户端面）。
- 看板声明的三个子席位（`task-board.detail.section`、`task-board.settings.section`、
  `task-board.card.decoration`）在 `src/client/index.ts` 以同形
  `declare module` 声明，不 value import 看板包；本包实际只向详情区与卡片
  徽章两个席位登记，仓库/凭据摘要在自有设置卡里渲染，不占看板席位。
- 看板的账本、列门禁、内容冻结与事件隔离都由看板执行：本包只读写
  `tasks.*` / `integration.*` 能力面。远端不可变身份索引是扩展自己的结构，
  在 `start()` 时从 `tasks.list()`／`tasks.linked()` 建立并随
  `onTaskDeleted` 维护；扩展自身不得抛出未捕获异常。
- 两侧半区都经 `ctx.inject(['taskBoard'], ...)` 等待看板的提供方服务：宿主
  半区登记 provider，浏览器半区安装两个席位；服务后到也能挂上（聚合的
  mount-children 不保证 `ctx.plugin` 的 apply 顺序），服务撤走即自动释放。
  聚合包仍把本包的行排在 `../dsh-task-board` 之后（见
  `packages/dsh-web-all/aggregate.yml` 注释），但那是加载顺序的可读性偏好，
  不再是正确性的前提。禁止改回一次性 `ctx.get('taskBoard')` 解析。
- GitHub 令牌只经 `tokenEnv` 指定的环境变量在宿主半区读取，不得进入浏览器、
  设置卡或 agent 工具面。

## 半区分层

- `src/index.ts`：host 入口（Config schema、提供方登记与 `announceToAgent`
  公告）。
- `src/host/`：host 半区实现（GitHub REST 客户端、同步服务、提供方工厂、
  五个模型可见工具）。
- `src/core/`：两侧共享的纯逻辑（契约同形声明、GitHub 领域类型与校验、
  标签投影、定时器席位）。
- `src/client/`：浏览器半区（locales、设置卡、两个席位与可见性谓词）。卡片
  文案一律经 locales 字典，客户端源码不出现裸中文。
- 开关语义：`enabled` 同时门禁 host（停轮询、停写回、注销工具、清空
  publish）与 client（撤下席位、停订阅）；看板总开关与本扩展开关叠加，
  两者都不改契约。

## 共享副本

`src/mount-once.ts`、`src/client/{settings-form.ts,PluginSettingsCard.tsx,settings-card.module.css,settings-entry-form.ts,plugin-card-seat.ts}`
与 `vitest.setup.ts` 是 `scripts/sync-shared.mjs` 生成的同步副本（文件头有
generated 注释），禁止手改；改动 shared/ 源后重跑 `node scripts/sync-shared.mjs`。
