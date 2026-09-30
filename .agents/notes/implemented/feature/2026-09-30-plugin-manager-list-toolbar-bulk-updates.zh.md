# Agent Note: Plugin-manager list toolbar: bulk third-party updates and an explicit restart

Status: implemented

## Problem

本包的更新检查此前是「一包一页」：官方「插件」页把 `plugins.detail.section` 渲染在组合包页面上，因此要把已装集合与各自 registry 来源比一遍，就得逐个打开包页面点「检查更新」。用户打开这个页面真正想问的问题——「我装的东西有没有过期的，能不能一把修好」——在列表上没有答案。

官方页面的两个事实决定了设计。它没有在「已安装」标题旁声明任何席位（它的扩展点是 `plugins.detail.actions` / `.badge` / `.section`、`plugins.item`、`plugins.bundle.config`、`plugins.row.config` 与 `plugins.bundle.activation`），并且它自己写明已装插件要靠卸载再安装来升级：因此本包应用的每次更新都只能在宿主下次启动时加载，而页面此前没有任何重启入口。

## Decision

本包新增第二个界面：列表级更新工具条，由 `src/client/plugin-toolbar-mount.tsx` 挂进 `[data-plugin-panel] [data-plugin-group="bundles"]` 的标题元素——也就是官方页面自己的「已安装」标题。容器是一个自持 React root 的普通元素（`PluginListToolbar`），因此绝不参与页面自身的 reconcile；它靠家族共享的 body mutation hub（`shared/client/body-mutations.ts`，本包内为生成副本）自查位，并在重复 apply 时用 `TOOLBAR_MOUNT_SELECTOR` 去重。

一次点击经由单页区块所用的同一条双通道 face 检查全部已装插件（一次 `check-updates` 调用），面板列出有新版本的行。**全部更新**按顺序对合格行调用 `update(id)`，显示逐行进度，遇到第一个失败即停止并把其余行连同版本留在列表里；每行带一个状态属性承载宿主报告的兼容判定。

两条策略放在浏览器半区的 `src/core/updates.ts` 而非宿主，使同一批行对单页区块依然可用：只有第三方包（非 `@deepseek-ai/`）参与批量更新——随 DSH 发布的包的版本属于安装本身，官方页面也这么告诉用户；声明的 DSH 最低版本高于当前运行时的行会被列出但绝不应用（宿主本来也会以 412 拒绝）。

随后工具条提供 **立即重启**，POST 到新增的 loopback 门禁路由 `POST /api/plugin-manager/restart`。路由回答它实际采用的模式，而模式是对本进程启动事实的纯函数判定（`src/host/restart.ts` 的 `planRestart`）：

- **`shell`** —— 打包桌面应用拥有这棵进程树（`facts.desktop`，或环境里的 `ELECTRON_RUN_AS_NODE`）。插件无法重启 Electron 应用，detached 重拉又会与外壳抢同一端口、同时被外壳报成宿主崩溃，因此宿主只退出：由外壳自己的恢复对话框提供重启，也就是它更新流程所用的同一个 `app.relaunch()`，插件集合随之重新加载。工具条提示指向该对话框。
- **`relaunch`** —— 终端启动（交互式 stdio 且环境无 Electron）重放自己的命令行：detached helper 等旧进程退出后，用同一 `execPath` + argv 拉起替换进程（剔除 inspector 开关，因为它们会重复绑定固定端口），输出追加到 `$DSH_HOME/logs/plugin-manager-restart.log`。
- **`manual`** —— 无终端的启动（受监督进程、编辑器任务）既不被重启也不退出；工具条提示手动重启。

重拉时 helper 起不来会降级为 `manual` 而不是退出，因此无法被替换的进程会继续运行。

## Alternatives considered

- **再找第四个官方席位。** 没有：页面在列表层不声明任何席位，它声明的席位要么按对象、要么属于配置条目。注册一个空的 `plugins.item` 卡片到「官方」分组里放按钮，会把动作放进错误的列表并改变页面自身的清单渲染。
- **用 `ctx.slots` 贡献工具条。** 槽位只在页面声明它的地方渲染；列表级动作只能插入，这正是容器采用自持 React root + 共享 mutation hub 自查位（与侧边栏底部卡片同一手法）而不是槽位条目的原因。
- **让客户端半区去驱动 Electron 重启。** `window.dshDesktop` 只暴露 `updates.status/open/subscribe`（协议版本 1），打包外壳的 `app.relaunch()` 只能从它自己的对话框到达。调用 `updates` 桥只在「恰好已下载了 DSH 更新」时才会重启应用，与插件更新无关。
- **在所有平台上由插件重启宿主。** 打包桌面应用下 detached 重拉会复制一个外壳自认为拥有的服务器，随后外壳把原宿主报成崩溃。因此桌面路径选择「退出并交给外壳」，而无终端的启动完全不动。
- **更新检查返回的所有行，含官方包。** 由插件重装 `@deepseek-ai/` 包可能把运行时依赖挪离当前 DSH 构建与测试时的版本，而官方页面已经告诉用户这些包随 DSH 升级。宿主仍然报告它们（单页区块也仍然可以逐个更新），所以这只是浏览器侧策略，不丢数据。
- **桌面路径无条件退出宿主。** 重启是用户点击，只有在用户确认重启之后才让外壳弹出崩溃恢复对话框是可以接受的；但静默执行（例如更新完成即退出）会把一次正常更新变成一场「崩溃」。

## Consequences

- 官方「插件」页的列表视图现在在「已安装」标题旁带有「检查更新」与「立即重启」，以及列出更新行的浮层。单页 `plugins.detail.section` 区块不变，仍可更新单个包（含官方包）。
- 页面不在列表视图时工具条消失，标题被重建时它自动重新就位；非 loopback 浏览器上完全不渲染（检查按钮禁用并给出仅限本机的说明）。
- 重启在宿主能替换自己的运行时是真能力，在打包桌面应用上是「交给外壳」，在其他情形是一句提示。没有任何地方谎称发生了重启：路由回答它使用的模式，界面把该模式原样回显。
- 桌面路径上用户会看到外壳的恢复对话框（标题「DeepSeek Harness is unavailable」），外壳还会写一份崩溃报告。这是外壳唯一重启入口的代价；它被选择而不是做一个无法让更新生效的插件。
- `src/host/restart.ts` 是带进程级效应的宿主代码，与其他网关路由一样受 loopback 门禁保护；它绝不臆造命令行。工具条文案位于 `settings.pluginManager` 命名空间，并镜像进 `dsh-i18n` 的 ru 字典。
- `scripts/sync-shared.mjs` 现在也把 `shared/client/body-mutations.ts` 复制进本包（`src/client/body-mutations.ts`，生成文件，绝不手改）。

## Testing

- `packages/dsh-plugin-manager/tests/plugin-list-toolbar.spec.tsx`（12 例）：仅限本机的降级、摘要与面板里的第三方过滤、已是最新的判定、检查失败、只按顺序触碰合格行的批量运行、被列出但绝不应用的被阻塞行、失败即停止并保留其余行、摘要随应用进度递减、重启确认（确认、取消、桌面提示、被拒绝的重启）。
- `packages/dsh-plugin-manager/tests/plugin-toolbar-mount.spec.tsx`（6 例）：落在「已安装」标题里的席位、重复挂载为空操作、离开列表视图时无席位、标题重建后重新就位、卸载、以及语言切换后重新渲染已挂载副本。
- `packages/dsh-plugin-manager/tests/restart-plan.spec.ts`（10 例）与 `tests/restart-route.spec.ts`（4 例）：每种模式判定、inspector 开关过滤、helper 起不来时降级为 manual、loopback 门禁，以及 manual 判定绝不安排退出。
- `packages/dsh-plugin-manager/tests/host-apply-desktop.spec.ts` 断言注册的路由集合，其中现在包含 `/api/plugin-manager/restart`。
