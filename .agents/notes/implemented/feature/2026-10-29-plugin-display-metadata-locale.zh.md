# Agent Note: 插件页展示元数据经由 locale 文件与聚合家族本地化标题

Status: implemented

> 注：本决定取代了此前 [聚合包的退役插件登记改由清单生成](../bug-fix/2026-10-17-aggregate-retired-plugin-registry.zh.md) 中保留退役插件条目的做法：五个已退役家族已从 tombstones、exports 与退役登记中彻底移除，不再保留空壳与元数据。

## 问题

官方插件列表（设置 → 插件列表）此前给独立插件展示裸 npm 包名（如 `@linxin666/dsh-web-settings`）及英文 `package.json.description`。在聚合包（`@linxin666/dsh-web-all`）中，作为子路径导出挂载的各家族行，其卡片标题取自挂载说明符标签 `web-all/<family>`（[聚合家族行经子路径导出显示真实插件名](../architecture/2026-09-02-aggregate-family-row-display-names.zh.md)），而非面向用户的本地化名称。此外，四个包（`dsh-browser-view`、`dsh-task-board-remote`、`dsh-task-board-team`、`dsh-win-bash`）此前缺少 `icon.svg`，展示通用占位插画。最后，五个此前已退役的家族（`describe-image`、`desktop-launcher`、`doctor`、`dsh-perf`、`model-capabilities`）仍残留着空壳导出、退役登记和元数据导出，增加了清单维护成本。

## 决策

家族所有包、根 bundle 以及聚合包全面接入官方 DSH 展示元数据通道，补齐图标素材，将聚合家族行改为本地化标题，并彻底移除五个已退役家族。

### 官方元数据通道与 exports 严格对齐

宿主（`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`）从 `<specifier>/locale/<lang>.json` 读取行标题与灰色描述（`meta.title` 与 `meta.description`）。宿主解析顺序有严格要求：先尝试解析 `<specifier>/locale/en.json`，再枚举该目录下所有 `*.json` 文件并逐个走包的 `exports` 映射解析。

磁盘文件与 `./locale/<lang>.json` 导出键必须严格一一对应。若磁盘存在文件但缺少导出键，或声明了导出键但磁盘缺少文件，宿主读取元数据时都会抛错，并静默回落为 npm 包名和英文 `package.json.description`。

### 包级覆盖范围与语言回落机制

`packages/` 下共 23 个包（22 个子包加聚合包 `dsh-web-all`）。本次改动为 21 个插件包补齐了 `locale/en.json` 与 `locale/zh.json`；另有两个既有包（`dsh-agents` 与 `dsh-remote-bridge`）早已自带 locale 且带有 `ru.json`。每个包均导出其 `./locale/<lang>.json` 文件并在 `package.json` 的 `files` 白名单中加入 `"locale"`。本次补齐的 21 个包包级只随 `zh` 与 `en`，既有的两个包另带 `ru.json`；当用户处于没有独立语言包的环境时，宿主自动回落到 `en`。插件界面的俄语词表继续集中在 `packages/dsh-i18n` 维护。

仓库根的 bundle 包（`package.json`，name 为 `dsh-web`、private、指向聚合 patch）同样随包提供 `locale/zh.json`（"全家桶" / "一键装齐 DSH Web 官方插件"）与 `locale/en.json`（"Web bundle" / "Install every DSH Web plugin in one step."），并在根 `files` 里加入 `"locale"`。由于根 bundle 没有 `exports` 字段，宿主按文件路径直接解析，不需要导出键；新门禁 `scripts/plugin-display-metadata.test.mjs` 仅扫描 `packages/*`，不校验根目录。

宿主按请求实时读取展示元数据，修改 locale 文件后只需在浏览器中刷新页面即可生效，无需重启宿主服务。

### 图标补齐

此前缺图标的四个包（`dsh-browser-view`、`dsh-task-board-remote`、`dsh-task-board-team`、`dsh-win-bash`）补齐了标准家族 `icon.svg`（与 `packages/dsh-web-all/icon.svg` 字节完全相同），在 `package.json` 顶层声明 `icon`，并将 `"icon.svg"` 加入 `files`。至此家族全部包与聚合包均具备完整卡片插画。

### 聚合家族行本地化标题

聚合家族行不再使用说明符标签 `web-all/<family>` 作为展示标题。在 `packages/dsh-web-all/aggregate.yml` 中，每条 `shellNotes` 现声明 `title: {zh, en}` 及描述文案。生成器（`scripts/aggregate.mjs`）将其写入 `shell-metadata/<family>/locale/<lang>.json` 的 `meta.title`（缺独立 `ru` 标题时回落 `en`）。但注意自 2026-10-18（issue #1901）之后，`cordis.patch.yml` 中的现代家族行直接挂载真包名，插件页行标题来自真包自己的 locale；`shell-metadata` 的本地化标题只对老 profile 里仍以 `@linxin666/dsh-web-all/<family>` 命名的子路径行生效。

本决定部分取代了 [聚合家族行经子路径导出显示真实插件名](../architecture/2026-09-02-aggregate-family-row-display-names.zh.md)：仅取代了“家族行标题即挂载说明符标签 `web-all/<family>`”这一半决定，子路径导出与故障隔离壳机制对老子路径行依然有效。

生成器实行严格闭锁校验：缺 title、未知家族 id、重复 id、中文标题与英文同串（允许拉丁产品名如 "Windows Bash"）、中文说明不含汉字、超 20 汉字或与英文同串均直接报错。

### 彻底移除五个已退役家族

五个已退役家族（`describe-image`、`desktop-launcher`、`doctor`、`dsh-perf`、`model-capabilities`）从聚合包彻底移除：

- 删除 `aggregate.yml` 中的 `shellNotes`、`tombstones` 与 `retiredPlugins` 条目。
- 删除生成的 `shell-metadata/<family>/` 目录。
- 从 `packages/dsh-web-all/package.json` 中删除 25 个导出键（5 个子路径、5 个图标及 15 个 locale 文件）。

代价与权衡：仍引用这五个家族子路径（`@linxin666/dsh-web-all/<family>`）的陈旧用户 profile 在导入时将因无法解析导出而失败并被记录为失败或降级的导入，而不再是静默跳过的空壳。宿主不会因此中断启动：上游 `auditStartupEntries` 只对 required 条目抛出 `StartupError`，其余条目仅产生告警日志、兄弟插件照常运行。保留了 `retiredPlugins:` 段头与壳跳过逻辑作为空清单，供未来插件退役使用（当前登记为空，测试断言五个家族在任何展示面上均不得出现）。

## 替代方案

- 为每个包随包提供 `ru.json`：否决。独立界面的俄语翻译集中在 `packages/dsh-i18n`，避免各包维护成本膨胀。宿主回落到英文足以满足展示需求，而聚合子路径因无法被 `dsh-i18n` 寻址才单独保留俄语元数据。
- 在 `package.json` 中读取自定义字段：否决。宿主 `dsh-app-boot` 的官方契约明确要求读取 `<specifier>/locale/<lang>.json`。自行定义诸如 `package.json.dsh.display` 的字段无法被官方插件列表识别。
- 为五个退役家族保留空壳导出：否决。永久保留 25 个导出键与元数据目录带来持续维护负担并混淆活跃子路径。彻底移除确保未来重新引入这些能力必须经过明确的产品决策。

## 后果

- 新包必须随包提供 `locale/{en,zh}.json` 与 `icon.svg`，在 `package.json.exports` 与 `package.json.files` 中声明，且中文描述控制在 20 汉字以内，否则插件页将回落为裸包名。
- 引用已移除家族子路径的旧 profile 在导入时失败并被记录为降级/失败导入，宿主仅告警并保持兄弟插件正常运行，不会中断启动。
- 展示元数据的改动在浏览器刷新后即时生效，无需重启 `dsh web`。

## 测试

- `scripts/plugin-display-metadata.test.mjs` 校验 `packages/` 下所有包的 `locale/` 磁盘文件与 exports 严格一一对应、`meta.title` 与 `meta.description` 非空、中文描述符合 20 汉字限制、以及包内图标位于 `files` 且小于 256 KiB。
- `scripts/aggregate.test.mjs` 断言五个退役家族在 patch 行、tombstones、retiredPlugins、shellNotes 及 package exports 中均不存在，并验证 shell 元数据完备性。
- 两组测试均在 `pnpm test:scripts` 中执行并通过。
- 在运行中的 DSH Web GUI 上实测验证，页面刷新后根 bundle 行的标题与描述即时更新为「全家桶」与「一键装齐 DSH Web 官方插件」。
