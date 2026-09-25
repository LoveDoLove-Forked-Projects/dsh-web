# Agent Note: 一个中栏面板家族

Status: implemented

## Problem

`conversation` 是单占槽位，外部插件只能在中栏做 DOM 级接管。此前这种占用是**成对**表达的：每个面板只声明一个兄弟的激活名与 `<html>` 属性（ssh ↔ task-board），并在自己的样式表里带 `:not([兄弟])` 守卫。

技能中心（`dsh-skill-explorer`）原本是挂在 body 上的浮层模态，从不属于这个家族。把它迁进中栏后，三个面板共用一个槽位，成对形态表达不了这个约束：不认识第三个面板的那个面板会「逻辑上还开着、但不可见」，它的侧边栏入口要点两次才重新打开——正是成对写法注释里警告过的那个失败模式，如今又往外推了一层。

## Decision

占用关系落在 `shared/client/panel-mount-core.ts` 的一张表里：

```ts
export const PANEL_FAMILY: readonly PanelFamilyMember[] = [
  { panel: 'taskboard', activeAttribute: 'data-dsh-taskboard-active' },
  { panel: 'ssh', activeAttribute: 'data-dsh-ssh-active' },
  { panel: 'skill-explorer', activeAttribute: 'data-dsh-skill-explorer-active' },
]
```

打开某个面板时清除表内其他行的属性，并在 `dsh-panel-activate` 上广播自己的名字；已打开的面板收到不是自己的名字就关闭。消费方只传 `panelName` 与自己那行的 `activeAttribute`——成对 sibling 参数已删除，成对的 `:not()` 守卫只保留为「两个属性万一并存」时的兜底。

技能中心的浏览器半区现在是中栏面板：`mount.tsx` 包装 `mountCenterPanel`，`src/client/panel/` 放壳（`SkillPanel.tsx`：带返回控件的头部、页签栏、内容区）、技能/创建/编辑三个页签（编辑页签只在正在编辑某个技能时出现，沿用插件既有的 read/update 链路），以及 `panel.module.css`（由 `skill-panel.module.css` 改名），使用家族词汇——`.panel` / `.panelHeader` / `.tabBar` / `.tab` / `.toolbar` / `.ghostButton` / `.primaryButton` / `.linkButton` / `.badge` / `.empty` / `.banner` / `.field`——并继续遵守本包的样式纪律：只用主题 token。

语义部件随之调整：`card` 与 `head` 退役（没有模态卡了），`tab-bar` / `tab` / `skill-row` / `filter-bar` 保留；`wallpaper-exclusive` 皮肤里技能中心的锚点从 `card` + `head` 改到插件根 + `skill-row`，面板根也加入该皮肤的插件面板玻璃清单。

## Testing

家族生命周期用例（`packages/dsh-ssh/tests/center-panel-lifecycle.test.tsx`）现在挂载三个面板，断言第三个面板能顶掉任何占用中栏的面板，并校验两侧的 html 属性。技能中心自身的面板用例覆盖壳（头部、页签、激活页签）、返回控件关闭控制器、列表的 last-good 策略、变更身份，以及创建页签在「先打开它」时通过一次 list 调用解析工作区。

## Alternatives considered

- **把成对 sibling 扩到三方**（每个面板列另外两个）：N² 配置，且每加一个面板都要改其他面板的挂载；失败模式从「表里少一行」变成「配对写漏了一个」。
- **技能中心自带接管**，打开时靠广播别人的名字关掉对方：零跨包改动，但机制变成针对单个面板的 hack，下一个面板还要再付一次同样的代价。
- **保持浮层模态、只换视觉**：最省，但面板的打开/关闭方式仍与家族其余面板不一致，而这正是本次迁移的目的。

## Consequences

- 打开家族内任何面板都会关掉另外两个，控制器状态一并处理；「点一下没反应」这个失败模式从结构上消失。
- 第四个中栏面板只需在 `PANEL_FAMILY` 加一行；若它想指定兜底优先级，仍需在自己的样式表里写守卫。
- 技能中心不再有遮罩关闭或 Escape 关闭：它通过返回控件、侧边栏会话行点击、或被家族驱逐来关闭；Escape 只用来清空搜索框。
- `dsh-skill-explorer` 现在会生成一份 `panel-mount-core.ts` 副本，因此 `scripts/sync-shared.mjs` 对该文件列出三个消费方。
