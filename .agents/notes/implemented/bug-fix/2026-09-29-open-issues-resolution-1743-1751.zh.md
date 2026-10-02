# Agent Note: 未结 Issue 处理（#1743, #1744, #1745, #1746, #1748, #1751）

Status: implemented

## 问题

本批次六条 Issue，四条是本仓可定位的缺陷，两条转交自 dsh-deep-whale：

1. **#1751** —— 「Web 插件中 启用远程访问 强制默认值，保存必然失败」。宿主把 `settings/mutate` 整段包在 `hmr.runExclusive` 里；提交 volatile 字段会同步派发 `loader/volatile-update`，`remote-web-ui` 的 `sync()` 就在同一条异步上下文中把 `cordis.patch.yml` 写了出去——而那正是 HMR 配置监听器盯着的文件。监听器的 refresh 二次进入 `runExclusive`，直接以 `HMR transactions cannot be nested` 拒绝，用户的保存因此失败。报错文案此前被回复成「没有渲染出来」，实际截图里确实只有红字没有原因。
2. **#1748** —— `task_board_update` 的 `permission` 参数用 `enum: [...TASK_PERMISSIONS, '']` 把清空值混进枚举。经 OpenAI 兼容中转转发到 Gemini 时，`enum` 的空成员被判为非法，整个请求返回 400；工具定义随每次请求下发，所以连普通问候都会中招。
3. **#1744** —— 官方桌面客户端内 SSH 终端必然 `connection error`，而同一面板的 HTTP 面全部正常。客户端从 `location.host` 拼出 `ws://app/...`；桌面外壳用 `dsh-app://app/` 交付页面，其 protocol handler 只转发 HTTP，自定义协议承载不了 WebSocket 升级。
4. **#1743** —— ORCA LINK 皮肤左上角「插件」点不开。宽屏舞台的「新建会话」命中面按*画出来的小人*尺寸（`stage - 66`）定高，而原生面板列表被推到 `stage - 116`，命中面因此盖住列表前 ~108px。#1732 的修复只调了 z-index，没有核对两者的实际几何。
5. **#1745 / #1746** —— 转交自 dsh-deep-whale#160/#161：maid-atelier 0.3.2 在 Windows 桌面端背景插画整层不可见、整窗被均匀深蓝铺满；侧栏收起后 `--maid-sidebar-width` 不更新；`[class*="titlebar"]` 锚点在桌面版全部落空。

## 决策

1. **会改写被 HMR 监听文件的副作用必须换一条异步上下文（#1751）**：LAN bind 块写入与防火墙探测移入 `applyLanBindWork`，只经 `scheduleLanBindWork()` 走 `runDetached`（`src/detached-work.ts`）调度。该断言幂等（先比对现状再写），所以被合并的第二轮 `sync()` 不会重复写盘；延期值在执行时经 `resolve()` 重新读取，一 tick 内的两次切换落在最后一个提交值上。延期执行抛错只记录不外抛——保存早已应答，设置卡有自己的轮询读回活状态。

   **更正（#1754，2026-09-30）。** 本笔记原先用「`setImmediate` 起的是新的 AsyncLocalStorage store」来论证这条延期。该说法是错的，并在 Node 24 上被实测推翻：AsyncLocalStorage 会传播进 `setImmediate`、`node:timers`、promise 续体，以及任何以当前 async id 为 trigger 的 AsyncResource。延期因此从未把写盘与保存事务分离，#1754 报告 0.4.4 上同一故障依旧。`runDetached` 用能真正生效的机制替换了那个前提：模块作用域创建的一个 `AsyncResource`——创建时任何事务都还不存在——不携带 store，由它调度出去的一切继承这份空上下文，而不是调用方的标记。上面那条幂等守卫仍然保留，但它是第二道保险，不是修复本身。同一轮还修正了该改动留下的漂移：#1754 的客户端保存队列此前被写进 `packages/dsh-remote-web-ui/src/client/settings-form.ts`——一个由 `scripts/sync-shared.mjs` 生成的副本——而不是它复制自的 `shared/client/settings/settings-form.ts` 源文件。
2. **清空值不进 `enum`，改用 `oneOf` 精确分支（#1748）**：`permission` 拆成 `oneOf: [{ type: 'string', enum: [...TASK_PERMISSIONS] }, { type: 'string', const: '' }]`。合法值校验与「空串清除」语义都保留，而 `enum` 里不再出现空成员，网关的 Gemini 转发不再被拒。
3. **按「网页方案」而非「已知外壳方案」分类（#1744）**：`terminalSocketUrl()` 只在 `WEB_PAGE_PROTOCOLS` 列出的方案上拨号，其余方案返回 `undefined`，客户端据此直接回报可执行的说明（改用浏览器打开 Web 界面），而不是开一个注定失败的 socket 再报 `connection error`。该清单与 remote channel 的 `isWebPageProtocol`、update 席位的 `isApplicationDeliveredPage` 描述同一事实，取网页侧可覆盖官方将来发布的任何外壳。

   **部分被取代（#1744，2026-10-02）。** 拒绝 socket 对页面而言是对的，对外壳却是错的：桌面外壳已经通过 `__DSH_TRANSPORT__.streamBaseUrl` 公布可达的 Host authority 并改写其 WebSocket 握手，终端改为拨向那里，而不是在产品自家客户端上把操作者引向死路。`WEB_PAGE_PROTOCOLS` 仍用于判定页面，只是不再终结整个判断。见[终端改拨外壳自有的 Host](2026-10-02-ssh-terminal-dials-shell-owned-host.zh.md)。
4. **命中面止于列表起点，而非舞台接缝（#1743）**：`orca-link` 宽屏 `::before` 的高度改为 `calc(var(--orca-stage, 300px) - 174px)`，使 `58 + (stage - 174) = stage - 116` 恰好落在 `nav` 自己的 `margin-top` 上；右下角标记随之移动。绘制的小人仍占满整个舞台，被裁短的只有命中面。
5. **背景层要的是层叠上下文根，不是 z-index（#1745 A / #1746）**：皮肤给根元素上了不透明底色，宿主的 `backgroundMedia` 层（z-index: -2，append 到 body）因此不再向 canvas 传播，转而以「元素背景」身份绘制，排在负 z 图层之后——整层被压掉并非合成器问题。`body { isolation: isolate }` 让 body 成为层叠上下文根，底色退回第一步、`-2` 层回到第二步，同时该层仍位于立绘舞台（z-index 0）之下、正文面板之上；不改动 z-index，因为抬到 0 会盖住会话界面。此规则必须写在 `body` 上：skin-center 的 `/patches` 管线会给每条选择器前缀 `html[data-dsh-skin="<id>"] `，写 `:root` 会编译成永不匹配的选择器。
6. **收起宽度 0 是合法状态（#1745 B）**：`applySidebarWidth` 的 `width <= 0` 早退改为 `width < 0`。官方 Windows 桌面实现的 `collapsedWidth` 在 `data-windows-titlebar` 下就是 0（56 属于另一种形态），早退因此让 `--maid-sidebar-width` 与 `data-maid-sidebar-size` 冻结在上一个展开值。
7. **标题栏装饰优先用官方稳定属性（#1745 C）**：`decorateTitlebarBrand` 先看 `html[data-windows-titlebar]` 并取 `.frame`，再回落到哈希类名查找。桌面版外壳不提供可匹配的类名，网页版两者都没有。

## 后果

- 远程访问的任意一次设置保存都不再失败；LAN bind 的受管块仍在下一次 profile 应用时生效，卡片的 `pendingRestart` 语义不变。
- 经 Gemini 中转链路时，任务看板的八个工具随请求下发不再触发 400；「清除权限绑定」仍然可用。
- 桌面客户端的 SSH 终端页会明确说明本页无法承载 WebSocket 并指向浏览器，而不是笼统的 `connection error`。
- ORCA LINK 宽屏下插件列表的每一行都重新可点，新建会话的舞台命中区只覆盖真正的空白带。
- maid-atelier 的宫殿背景在桌面端重新可见；侧栏收起态归位；桌面端标题栏品牌装饰改由官方属性锚定。

## 覆盖缺口

- #1743 的几何在 jsdom 中不可验证（无布局），断言针对的是浏览器会应用的声明与两者的实际几何关系；真实逐帧点击仍需复现环境验证。
- #1745 / #1746 的 `isolation: isolate` 方向由报告者在同款宿主上实测有效（`z-index: -2` 层恢复出图、正文未被覆盖、立绘正常），本仓按该读数落地，未再单独复现。
- #1751/#1754 的回归用例断言的是放置与机制规则（哪些函数触碰 patch 文件与防火墙、延期是否走 `runDetached`，以及 `tests/detached-work.spec.ts` 中「裸 `setImmediate` 确实继承事务、`runDetached` 不继承」）。两者都不是由真实设置保存驱动的真实 HMR 事务端到端复现。
