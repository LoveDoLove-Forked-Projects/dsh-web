# Agent Note: orca-link 品牌选择框按整行而非字标取尺寸

Status: implemented

## Problem

在 orca-link 皮肤展开的侧栏里，左上角 DSH 字标的键盘选中高亮画出的是一个远大于字标的框：一条约两倍字标宽度的蓝色细矩形，横跨大片空白行区域，还把旁边的 LINK ACTIVE chip 一起框了进去。用户反馈这个高亮和图片不匹配。

根因：这个高亮并不属于皮肤。皮肤用字标 SVG 覆盖了宿主「新建会话」按钮的整个表面，但按钮本身是整行宽度的 `wide` 行控件：280px 侧栏下实测 216 x 30，而字标是 118 x 30，锚在行自身的 4px/15px 原点上。`patches.css:1417` 给所有 `:focus-visible` 描 2px 蓝色 outline、偏移 2px，而 orca-link 的样式表从未在这个控件上关掉它，于是选中框就是按钮的框。皮肤自己为同一操作准备的舞台边框反馈（`body[data-orca-sidebar-wide] ... button:not([data-dsh-part="sidebar-entry"]):before`）挂在一个兄弟控件上，从来没落到这个按钮上——所以用户唯一能看到的高亮就是这个尺寸错位的宿主 outline。

## Decision

字标的框在 `[data-orca-logo-row]` 上以自定义属性声明一次（`--orca-mark-x/y/w/h`），字标与新的选中框共同读取，两者不会再各自漂移。选中框是行的 `:before`——皮肤已经用同一个伪元素槽位画 logo 行的扫描线——带角括号与一道很淡的内描边，悬停时半透明，`:focus-visible` 时满透明度。同时在这个控件上关掉宿主 outline（`body[data-orca-sidebar-wide] [data-orca-link-brand]:focus-visible`），使字标周围唯一的框就是与它同尺寸的那一个。

该框规则按位置选中行内第一个按钮（`:has(> button:first-of-type:is(:hover, :focus-visible))`），而不是通过 `[data-orca-link-brand]`。它必须退出指针命中：绝对定位的框会绘制在普通流中 brand 按钮之上的定位层，否则会吞掉点击；brand 按钮必须保住自己命中区的每一像素。位置写法与收起栏相关规则早已使用的写法一致，同时让这条规则不必出现在 `orca-link-hit-targets.spec.ts` 守卫的选择器扫描里，而无需削弱该守卫。

## Testing

- Live GUI（运行中的宿主，端口 3080，orca-link 生效，明暗样式表均经皮肤中心加载）：在 1440x900 下测量并截图了静止、悬停、键盘聚焦三种状态。改动前宿主 outline 是 2px 蓝色、偏移 2px，落在 216x30 的按钮上。改动后框的盒子为 x=16 y=21 118x30，悬停不透明度 0.5、聚焦 1，四条边与字标自身的 rect 完全一致，按钮 outline-style 为 `none`。LINK ACTIVE chip 不再被框在内。
- 新建会话操作仍然有效：`elementFromPoint` 在字标中心命中 brand 按钮，点击后 UI 停在 hero 新会话场景。无页面报错。
- 收起栏不变：320px 宽时侧栏为 56px，字标缩放后宽度为 0 并隐藏，而该框规则限定在 `body[data-orca-sidebar-wide]` 下，那里不会画出任何东西。
- dsh-skins 的 `pnpm test`（775 用例、53 文件）、`pnpm typecheck`、`pnpm skin-center:check`、`pnpm skin-hooks:check` 均通过。

## Alternatives considered

- **把宿主按钮缩到字标大小。** 否决：行的布局归宿主主管，而按钮宽度正是新建会话的命中面；缩小它会让主操作更容易点空。2026-09-10 的 note 已经把字标区域确立为可见入口，命中面不该小于可见控件。
- **把框画在按钮自身的 `::after` 上。** 否决：宽模式规则已把按钮设为 `position: static`，并把它的 `::after` 让给舞台角标；而画在按钮上的框必须随宿主每次宽度变化重新调尺寸才能贴住字标。
- **用 `:has()` 在字标而非按钮上限定抑制。** 否决：触发状态必须来自按钮，且 `orca-link-hit-targets.spec.ts` 里的既有 `pointer-events` 守卫会让任何「选择器文本含 `[data-orca-link-brand]` 且带 `pointer-events: none`」的规则失败。位置写法与本表已经为该行首个控件采用的选择器同属契约稳定的选择器。

## Consequences

- 选中高亮现在在两种侧栏宽度下都读作它所属的字标；修复随皮肤资产发布：已安装的皮肤在下一次皮肤更新或重装时生效，文件变更后刷新页面即可（已实测）。
- 该框只在悬停与键盘聚焦时绘制，与皮肤为同一操作已有的舞台框一致；完全隐藏字标的收起栏不会有框。
- `[data-orca-logo-row]` 上的自定义属性是字标框的唯一来源。今后若要改字标尺寸必须走这些属性，否则框与图片会再次漂移。
