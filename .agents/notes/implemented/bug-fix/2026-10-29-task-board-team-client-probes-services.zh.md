# Agent Note: Task-board team client probes its services instead of reading them

Status: implemented

## Problem

rc.3 的 Web 外壳会因为某一个插件 apply 抛错而整体启动失败。用户在桌面版看到的现象是 `web boot: 1 entry did not activate` / `@linxin666/dsh-client-ui-task-board-team: failed`，对话框只提供「重装应用」这条路，GUI 始终没有渲染出来。

根因是外壳上下文的服务契约。cordis 4 的上下文只有在读取方**声明了** `inject` 的名字时才把服务解析成实现；未声明的属性读取不会返回 `undefined`，而是抛出 `cannot get property "<name>" without inject`。团队浏览器半区完全没有声明 `inject` —— 它的写法是容忍「这个部署没有设置界面」，于是把协作者当普通属性直接读：

- `bindSettingsForm` 先读 `ctx.configForms`，再读 `ctx.webUiSettings`
- `installTeamClientHalf` 把 `ctx.slots` 当作席位注册表
- `apply` 读 `ctx.locale` 注册词典与翻译席位

只有 `bindSettingsForm` 那次读取没有包在 try/catch 里，所以它是第一个抛出的；另外两处被 try/catch 挡成了静默空操作，同一个缺陷因此隐形。模块自己的注释承诺「缺失的席位注册表、语言服务或看板服务都被处理，绝不抛出」，那句话对**期望的值**成立，对**取值的动作**不成立。

同类缺陷此前在共享配对围栏上修过一次（issue #1942，[issue batch 1937-1942](2026-10-24-issue-batch-1937-1942-fixes.md)）：对未注入服务做属性兜底会抛出，而不是返回「什么都没有」。

## Decision

`packages/dsh-task-board-team/src/client/optional-service.ts` 承载唯一一个 `optionalService(ctx, name)`：它在 try/catch 内通过 `ctx.get` 解析名字，外壳不提供该服务时返回 `undefined`。两个客户端模块都经它读取协作者 —— 入口读 `configForms`、`webUiSettings`、`locale`，装配器读 `slots`。

- 客户端入口不声明 `inject`。声明会把「容忍缺失」变成硬依赖：fiber 会一直 pending 到每个席位都被提供，而没有设置界面的部署连看板的装饰与详情席位都会一起失去。
- 看板能力面的 `ctx.inject(['taskBoard'], ...)` 保持不变。它是运行时的依赖作用域，不是静态 inject 条目，能力面由 `resolveTaskBoardClientFace` 解析，那里本来就走 `ctx.get` 探测。
- 没有席位注册表的页面现在返回空 disposer 而不是注册席位：本扩展失去自己的贡献，看板照常渲染。

模块承诺的容错现在是**取值动作**的属性，而不是**值**的属性：未声明或未提供的服务一律回答「这里没有」，永远到不了启动检查那一关。

## Alternatives considered

在客户端入口声明 `export const inject = ['slots', 'locale', 'configForms']`（看板自己的入口就是这么写的）被否决。看板需要它的席位；本扩展是可选装饰，硬 inject 清单会让它的 fiber 在没有设置界面的页面上永远 pending —— 那是把今天的启动失败换成每个这类页面上的静默功能缺失。

保留属性读取、逐个包 try/catch 被否决为**主要形态**：它把取值规则重复到每个调用点，下一个协作者还要重新踩一遍。单独一个 helper 把规则收在一处，测试也指得准。

依赖外壳软化该错误，或用 `inject` 加可选依赖被否决，因为那不是本仓库的面：外壳的契约由 SDK cohort 固定，插件必须在它交付的那个 cohort 上可用。

## Consequences

桌面版在 0.2.1-rc.3 上带着该 profile 重新启动：看板、团队席位与设置区块都能挂上，没有任何条目拖垮启动检查。

本扩展以「减法」降级。没有席位注册表就不注册任何席位；没有设置界面时开关按已启用读取、席位照常挂载；没有看板服务时保留设置区块（开关与 Host Token 所在处），丢掉其余部分。

本包以后要读的任何客户端服务都必须走 `optionalService` 或声明 `inject`。把服务名当属性读现在等于启动失败，而不是一次 `undefined` 判断。

## Testing

`pnpm --filter @linxin666/dsh-client-ui-task-board-team test`：10 个文件 86 项通过，其中 `tests/client.spec.ts` 新增 `boot tolerance` 两条用例。它们构造一个强制执行 inject 契约的外壳上下文 —— 用 `Proxy` 对插件未声明的所有服务属性抛出 `cannot get property "<name>" without inject`，只让 `ctx.get` 作答 —— 然后断言 `apply` 不抛错，且设置区块经探测到的注册表注册。修复前该上下文能逐字复现线上报错。既有席位用例改为经 `ctx.get` 回答 `slots`，与真实外壳一致。

`typecheck` 与 `build` 通过。

交付运行时上的复现：用桌面版自带的 CLI 在探针家目录（`DSH_HOME=/tmp/...`，desktop profile 的副本）上启动 64991 端口的 web 服务，再用 Playwright 以无头 Chrome 加载。修复前页面渲染出「Failed to load plugins / @linxin666/dsh-client-ui-task-board-team / web boot: 1 entry did not activate」；修复后 GUI 正常渲染，`window.__dshTaskboardApplied` 为 `true`，无启动报错。探针实例与目录在验证后已清理。
