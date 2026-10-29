# Agent Note: Family plugin icons through the DSH display-metadata icon field

Status: implemented

## Problem

官方插件列表（Settings → Plugins）给每个已安装 bundle 都画同一张默认插画，卡片本身不携带任何身份信息：`@linxin666/dsh-web-all` 和旁边无关的第三方 bundle 看起来一模一样，独立安装的家族包也像任何一行普通插件。dsh 0.1.7-alpha.2 宿主现在会读取包导出的 `package.json` 里的可选图片字段，这是本仓库在该表面上可用的第一个宿主级展示元信息字段。

## Decision

`packages/` 下共 23 个包（22 个子包加聚合包 `dsh-web-all`）。家族各包都在包根放 `icon.svg`，并在 `package.json` 顶层声明 `icon`；该文件同时加入各包的 npm `files` 白名单，保证发布 tarball 带上它。此前缺图标的四个包（`dsh-browser-view`、`dsh-task-board-remote`、`dsh-task-board-team` 与 `dsh-win-bash`）补齐了与 `packages/dsh-web-all/icon.svg` 字节完全相同的标准家族 `icon.svg`。`packages/` 下与聚合 `icon.svg` 字节相同的共 18 个包（加上聚合包自身共 19 个），另有 `dsh-agents`、`dsh-message-edit`、`dsh-task-board-github` 与 `dsh-update` 使用各自不同的图标。Skin Center 已不在 `packages/` 里。`dsh-app-boot` 的 `readPluginMeta` 把该值按 manifest 相对路径解析，接受 SVG/PNG/JPEG/WebP 且上限 256 KiB，将字节 base64 成 `data:` URL，官方插件管理器在 bundle 卡片与详情页渲染该 URL。

## Scope and resolution

读取方通过包的 exports map 解析 `<specifier>/package.json`，因此 specifier 决定条目有没有图标：

- 家族每个包都导出了 `"./package.json"` 且可解析，所以它自己的卡片——聚合的，或独立安装的——都显示鲸鱼。
- 聚合内部的家族行以各自的模块说明符挂载；DSH 0.2.1 起，聚合为每个活跃家族子路径导出 `./<family>/icon` 与 `./<family>/locale/<lang>.json`（[插件页展示元数据经由 locale 文件与聚合家族本地化标题](2026-10-29-plugin-display-metadata-locale.zh.md)），在本地化标题旁渲染家族图标。五个已退役家族（`describe-image`、`desktop-launcher`、`doctor`、`dsh-perf`、`model-capabilities`）已随其子路径与元数据从聚合包彻底移除，因此“子路径行保持默认插画”的说法在当前活跃代码中已无实例。

把 `./<family>/package.json` 别名到某个包根曾被否决，因为把那份 manifest 交给每一行会让其 `name` 在客户端标题解析中抹平各不相同的行标题；聚合生成器改为通过维护专门的 `./<family>/icon` 导出直接指向家族标记。

## Artwork

这枚标记是家族自己的：一张本地生成的鲸尾（尾鳍）参考图离线矢量描摹而来（imagetracerjs 1.2.6，二次曲线拟合，512 单位网格），成为 `0 0 512 512` viewBox 上的一条闭合轮廓，填充为品牌蓝 `#4d6bfe`。同批生成的整只鲸鱼侧影是备选方案，在小尺寸上落败：16 px 时它的眼睛与胸鳍糊进身体，而尾鳍仍保持可辨认的 V 形。文件里没有任何来自上游 DeepSeek 字标或第三方图标集的内容：最初交付的那版用的是 `@deepseek-ai/dsh-client-ui-primitives` 的 `FISH_LOGO_PATH`，已替换——家族插件不该把厂商自己的标志当成自己的身份。填充用 `#4d6bfe` 而不是最初给的 `#edf4ff`，后者在浅色卡片上几乎不可见。该 SVG 不含脚本、外部引用或位图载荷，参考用位图不随包交付。同一份 3.8 KiB 素材被复制进每个包，因为读取方要求图标 realpath 后仍在自己的 manifest 目录内，包外的一份共享文件无法服务它们。

## Alternatives considered

`package.json` 内联 data URL：读取方拒绝一切非相对文件路径的值（绝对路径与任何 URI scheme 都抛错），所以该字段只能指向文件。

沿用上游 DeepSeek 鲸鱼标记：被否——那会让家族图标变成厂商标志的逐字克隆，而这恰恰是插件卡片最不该自称的东西。

手写 SVG 路径：先后产出并渲染过三版手绘稿，在卡片尺寸下都显得粗糙，因此交付几何改由描摹生成的参考图而来，而不是手搓坐标。

每个插件各画一枚图标而非共用家族标记：为全部插件设计互异字形是一份本次改动无法验证也无法维护的设计清单，卡片主要传达的是家族身份（而 `dsh-agents`、`dsh-message-edit`、`dsh-task-board-github` 与 `dsh-update` 使用各自不同的图标，Skin Center 已不在 `packages/` 里）。

只给聚合包配图标：独立安装 `@linxin666/dsh-ssh` 之类的包时仍是通用插画，且聚合详情页里每个家族行本来就渲染同一张默认插画——逐包一份素材的代价只是一个文件加一个 manifest键。

按家族各配一枚图标（各自 manifest）：每个 `lib/shells/<family>/package.json` 都需要一份图标副本，还需要一个能复现当前标签的 `name`，并且要动生成器维护的 exports map 与扫描器标记走查，只为了一处装饰。判定不成比例而否掉。

多包通过相对路径共享同一份图标文件：被否——realpath 包含规则禁止离开 manifest 目录。

PNG 或 WebP 素材：两者都被接受，但位图无法在卡片与详情页之间无损缩放，字节数也更多。

保留需求方给的 `#edf4ff` 填充：已实测在浅色卡片上不可见，而浅色是默认主题。

向上游要一个 bundle 级图标 API：没有必要——字段已经存在，并且无需加载插件代码即可读取。

## Consequences

聚合包与每个独立安装的家族包，其已安装卡片与详情页在两种主题下都显示鲸鱼，导出 `./<family>/icon` 的聚合家族子路径行也显示该图标。该值在每次 inventory 调用时从已安装包目录读取，因此浏览器刷新即可生效、无需重启 `dsh web`；只有发布 npm tarball 依赖新增的 `files` 条目来携带该资源，所以 npm 用户要等家族下一次发布才看到图标。该图标只是展示资源：没有任何运行时代码、契约或 profile patch 依赖它。`packages/` 下共 23 个包；与聚合 `icon.svg` 字节相同的 18 个包（`packages/` 下共 19 个包带该文件，`dsh-agents`、`dsh-message-edit`、`dsh-task-board-github` 与 `dsh-update` 用各自不同的图标，Skin Center 已不在 `packages/` 里）是对一个惰性文件的刻意复制，而不是需要程序化同步的事实源——构建期没有任何东西消费它们。

## Testing

`node scripts/aggregate.mjs --check`、`node scripts/lib-artifact-check.mjs`、`node scripts/verify-docs.mjs`、`pnpm i18n:check`、`pnpm emoji:check`、`pnpm skin-center:check`、`pnpm market:check`、`pnpm community:check` 与 `scripts/plugin-display-metadata.test.mjs` 全部通过，确认 `packages/` 下所有包均在 `files` 白名单中随包携带小于 256 KiB 的图标，说明生成器维护的 exports map、已提交的 `lib/` 指纹以及生成出来的 market 与目录产物都未被触动。

用运行中宿主自己的 `readPluginMeta`（从运行中的 `@deepseek-ai/dsh-app-boot` 导入），在一个 profile 形态的夹具上调用——一份 `package.json`，其 `node_modules` 链接全部家族包，正是 profile 安装的解析形态——全部 specifier 返回 `data:image/svg+xml;base64,...`，解码字节与该包 `icon.svg` 的 sha256 完全一致。以真实 `web` profile 根调用时 `@linxin666/dsh-web-all` 同样解析成功，而 `@linxin666/dsh-web-all/usage` 正确地不从其直接 manifest 返回图标。素材以真实 `<img src="data:image/svg+xml;base64,...">` 在 16/24/32/48/96 px 以及浅色与深色卡片上渲染验证，并查看 16 px 与 96 px 渲染，确认尾鳍在最小尺寸下仍可辨认、在最大尺寸下轮廓干净。未重启宿主。全仓 `pnpm -r test` 只在 `packages/dsh-task-board` 报失败（jsdom 下 `window.localStorage.setItem is not a function`）；把该包的 `package.json` 还原到 HEAD 后同样两个 spec 文件失败完全一致，说明这些失败先于本次改动、与之无关。
