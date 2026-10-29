# Agent Note: 聚合包的退役插件登记改由清单生成

Status: implemented

> 注：本决定的部分内容（五个已退役家族在登记表、tombstones 与 shell-metadata 中的留存）已被 [插件页展示元数据经由 locale 文件与聚合家族本地化标题](../feature/2026-10-29-plugin-display-metadata-locale.zh.md) 取代。五个已退役家族已彻底移除而不再走静默跳过，登记表当前为空清单，老 profile 的子路径行在导入时失败（被记录为降级/失败导入，不会中断宿主启动）。

## Problem

家族聚合包的故障隔离壳（`packages/dsh-web-all/src/shell.ts`）会跳过老 profile 里插件已退役的残留行：不挂载、不 import、不记账，于是一次正常退役不会进入 degraded 账本。这个跳过靠一份退役包名清单，而清单曾是壳旁边手写的字面量。手写清单会漂移。2026-09-23 移除 dsh-doctor 与 dsh-tool-describe-image 时删掉了两个包却没动它，于是仍带这两条行的 profile 穿过守卫落到 `await import(spec)`：包在工作区里已不存在，import 失败，`recordDegraded(spec, 'import', error)` 把一次有意退役变成 `GET /api/dsh-web-all/degraded` 上一条永久的「插件损坏」记录。后来的 model-capabilities 移除碰巧改了那份字面量，而这正是手工副本的失败方式：只有人记得时才对。

两个缺口让这种情况活了下来。没有测试覆盖本文要说的那个方向，即 shell-metadata 家族对 dependencies 与退役登记；既有的 children-consistency 只覆盖 patch 行对 `src/client/children.specifiers.json`。而 `node scripts/aggregate.mjs --check` 只逐文件比对期望内容，看不见某个 shell-metadata 家族目录或语言文件背后已经没有清单条目——`pruneShellMetadata` 只在写模式删它们。

## Decision

`packages/dsh-web-all/aggregate.yml` 新增 `retiredPlugins` 段：每个退役家族一条单行 JSON flow mapping，`{"family": "<tombstone 子路径>", "plugin": "<真实包名>"}`，风格与 `rows:` / `shellNotes:` 一致。清单是该列表的唯一事实源。当前随 [插件页展示元数据经由 locale 文件与聚合家族本地化标题](../feature/2026-10-29-plugin-display-metadata-locale.zh.md) 彻底移除此前五个已退役家族后，`retiredPlugins:` 保留为空清单。

`scripts/aggregate.mjs` 解析该段、fail closed 校验，并生成 `packages/dsh-web-all/src/retired-plugins.generated.ts`，与它已经拥有的 client-children 模块并列。生成模块导出 `RETIRED_FAMILIES`（子路径到包名，按 family 排序）与 `RETIRED_PLUGINS`（全部包名，排序，由 `RETIRED_FAMILIES` 派生）。校验拒绝非字符串或空字段、不匹配 `^[a-z0-9-]+` 的 family、尚不在 tombstones 段里的 family、重复的 family 或包名，以及同时是本聚合依赖的插件。每一条都是报错而非告警，因为任意一条都会产出一个要么让启动崩溃、要么静默吞掉在役插件的壳。

`src/shell.ts` 从生成模块导入 `RETIRED_PLUGINS`，包进和过去由字面量构造的同一个 `Set`。守卫在 `apply()` 里的位置与语义不变。

校验方向补齐在三处：`scripts/aggregate.test.mjs` 测试现在断言登记为空、且五个家族在任何展示面上都不得出现；`packages/dsh-web-all/tests/retired-plugins.spec.ts` 钉住针对生成文件的运行时契约；`aggregate.mjs --check` 现在把清单不拥有的 shell-metadata 条目报为漂移，于是丢了行却留着目录与导出的家族会让门禁红，而不是绿。

## shell-metadata 家族恰好只有两个来源

`shell-metadata/<family>/` 是生成的展示元数据，其中每个目录要么由依赖承载（壳包装行经 `config.plugin`，直挂行经自己的 `name`），要么登记为退役。测试按两个方向断言这个相等关系：既没有承载行也没有登记条目的家族报错，而承载行或登记条目找不到目录也报错。正是这一点让两个事实成为一个事实。tombstone 不是残留物——它正是让老 profile 的 `@linxin666/dsh-web-all/<family>` 行仍可解析的那个导出，所以只有在 family 仍留在 `tombstones:` 里时条目才能退役，顺序反过来生成器直接拒绝。随五个已退役家族彻底移除而不再留在 tombstones 中，登记表当前为空，活跃的 shell-metadata 目录严格对应活跃的行。

## Alternatives considered

- 直接删掉五个退役 shell-metadata 目录与它们那二十条导出：当时否决，后于 2026-10-29 改动（[插件页展示元数据经由 locale 文件与聚合家族本地化标题](../feature/2026-10-29-plugin-display-metadata-locale.zh.md)）中采纳。记录本决定时曾因希望老 profile 行保持静默解析而否决彻底删除。后经重新评估并采纳该做法：老 profile 残留的这些已移除子路径行名在导入时因无法解析导出而失败，并被记录为失败或降级的导入，但宿主并不会因此中断启动（上游 `auditStartupEntries` 只对 required 条目抛 `StartupError`，其余条目仅告警、兄弟插件照常运行）。此前「对每个升级用户的启动级故障」的说法偏重。
- 继续手写 `RETIRED_PLUGINS` 字面量，只补两个缺失的包名：否决。事实（哪些家族已退役、各自曾是哪个包）本来就住在 tombstones 旁边的清单里；壳旁的第二份副本是一份已经漂移过一次的副本，修好今天的漂移并不能阻止明天的。从同一段生成模块让漂移在结构上不可能，而不是靠人记得。
- 只用测试校验登记、不教 `--check` 认识多余 shell-metadata：否决。只校验一个方向而由写模式修剪另一个方向的门禁会一直是绿的，缺失的测试与缺失的检查当初正是这样共存的。

## Consequences

`retiredPlugins:` 段头与机制保留、当前无成员；未来若有插件退役，只需清单编辑（一条 `tombstones`、一条 `retiredPlugins`、一行 `shellNotes`）加一次生成器运行，壳不再需要人工编辑。此前五个已退役家族已彻底移除，不再走静默跳过。`src/retired-plugins.generated.ts` 是两个壳入口产物的构建输入，所以过期的副本由 `pnpm aggregate:check` 与已提交的 lib 指纹发现，而不是由一次报出假 degraded 的启动发现。模块很小且在渲染期冻结，因此壳在运行时依然不依赖清单。

门禁现在会把清单不拥有的 shell-metadata 目录报为 check 漂移。这是有意的耦合：展示元数据、子路径导出与退役登记是同一份家族清单的三个视图，任一单独移动都会红。将来某个聚合包若只带 shell 元数据而不带壳包则不受影响——登记模块与多余项检查都限定在壳真正所属的那个包上。
