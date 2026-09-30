# AGENTS.md — dsh-task-board-github

任务看板的外部提供方扩展（GitHub Issues 同步）。本文件只写本包特有规则。

## 与看板的边界

- 本包是 `packages/dsh-task-board` 的外部提供方：它不 import 看板的任何
  `src/**` 内部实现，跨包协作只走看板的提供方契约（cordis 服务），由看板
  侧拥有登记面。host 半区的登记位是 `src/index.ts` 里标注 TODO(M3) 的
  lifecycle 占位。
- 聚合展开时本包的行必须排在 `../dsh-task-board` 之后（见
  `packages/dsh-web-all/aggregate.yml` 注释），浏览器半区的卡片与宿主半区
  的提供方登记都依赖看板先行就位。
- GitHub 令牌只经 `tokenEnv` 指定的环境变量在宿主半区读取，不得进入浏览器、
  设置卡或 agent 工具面。

## 半区分层

- `src/index.ts`：host 半区（Config schema 与提供方生命周期）。
- `src/client/`：浏览器半区（locales、设置卡、卡片席位登记）。卡片文案一律
  经 locales 字典，客户端源码不出现裸中文。
- 本包不设 `src/core/`：尚无两侧共享的纯逻辑。

## 共享副本

`src/mount-once.ts`、`src/client/{settings-form.ts,PluginSettingsCard.tsx,settings-card.module.css,settings-entry-form.ts,plugin-card-seat.ts}`
与 `vitest.setup.ts` 是 `scripts/sync-shared.mjs` 生成的同步副本（文件头有
generated 注释），禁止手改；改动 shared/ 源后重跑 `node scripts/sync-shared.mjs`。
