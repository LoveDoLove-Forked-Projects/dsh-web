# Agent Note: 移除技能中心的「返回会话」控件

Status: implemented

## Problem

技能中心的面板头部带了自己的「‹ 返回会话」控件（`data-dsh-center-view-back`），
点击时调用 `controller.close()`，进而走到 `ctx.layout.selectPanel(null)`。在
DSH 0.2.0-rc.2 上，每次点击都能关闭面板，但界面会卡顿数秒才回到会话视图——每次
点击都可复现，console 无报错。卡顿出在面板切换这条路径上的大范围重渲染，而不是
处理器坏了：#1736 的修复（客户端 `inject` 声明 `layout`）正是让该控件开始生效的
前提，而报障者观察到的“慢”也是同一条切换路径。

该控件还重复了 shell 已经拥有的出口。技能中心是原生中栏页面：它的侧栏行
（`sidebar.panellist`）负责开合，而 shell 中每一条“显示会话”的导航——打开会话行、
“新建对话”按钮——本来就会调用 `selectPanel(null)` 把中栏交还给会话。官方插件页与
定时任务页都没有返回控件，技能中心这个反而是外观上的异类。

## Decision

移除技能中心的「返回会话」控件。`SkillPanel.tsx` 只渲染标题头部；从
`panel.module.css` 删除 `.backButton`（`.ghostButton` 保留——列表刷新与编辑器的
返回按钮仍在用）；并从本包的 `zh`/`en` 字典以及 `dsh-i18n` 集中承载的 `ru`
字典中删除已无引用方的 `panel.backToConversation` 键。

面板的进出方式与官方页面保持一致：侧栏行负责开合，任何会话导航都会把中栏带回
会话。`PanelController.open()`/`close()`/`syncPanelSelection()` 未改动——controller
仍然是 `panelOpen`、当前页签与编辑目标的属主，布局的 `panelInfo` 依然回灌其中，
因此侧栏行的开合与面板外部的切换照常工作。`close()` 现在由侧栏行而非头部按钮触发。

dsh-ssh 与 dsh-task-board 保留各自的返回控件：它们的会话是宿主侧的长生命周期资源
（SSH 终端、运行中的任务），且报障者并未要求改动这两处。`dsh-web-all/src/client/index.ts`
中面向 `[data-dsh-center-view-back]` 的移动端偏移规则保留，因为那两处控件仍带该标记。

## Alternatives considered

- **不去掉控件，而是排查并修复 `selectPanel(null)` 的开销**：作为本 issue 的持久解法
  被否决。切换路径属于 shell 的布局服务，其成本不由本包拥有；且报障者自己建议的处置
  就是移除，而该控件重复了 shell 已经提供的出口。若 shell 的面板切换仍然偏慢，那是上游
  `@deepseek-ai/dsh-client-ui-layout` 的问题，应按
  [上游根因 issue 分诊](../process/2026-09-06-upstream-root-cause-issue-triage.md)
  单独立 issue 反馈给核心包。
- **保留控件但让它变便宜（延后选择、跳过重渲染）**：否决。这会保留一个冗余出口，并用
  插件侧的变通手段掩盖 shell 拥有的成本，与官方页面越走越远。
- **一次性移除三个家族面板的返回控件**：否决。报障范围限定在技能中心；dsh-ssh 与
  dsh-task-board 托管着活的资源，其出口控件是否保留是另一个问题。

## Consequences

- 技能中心现在与官方插件页、定时任务页一致：只有标题头部，进出经由侧栏行与会话导航。
- 报障的技能中心返回控件多次点击卡顿随控件一并消失：面板内已无任何位置再要求布局
  重新选择会话。布局自身的面板切换成本未变，在面板间或行间切换时依然可观察。
- `panel.backToConversation` 不再是 `dsh-skill-explorer` 命名空间的键；它在仍在使用
  它的 ssh 命名空间中保留。
- `controller.close()` 已经没有页面内调用方；面板的开合仍由侧栏行的 toggle 与
  `panelInfo` 回灌这两条路径负责。

## Testing

- `tests/panel.spec.tsx` 断言头部只有标题、不再渲染任何 `[data-dsh-center-view-back]`
  节点或返回文案，且页面内没有任何关闭入口。
- `tests/panel-state.spec.ts` 继续锁定布局握手、controller 持有的页签与编辑目标，
  以及引用稳定的快照。
- `pnpm --filter @linxin666/dsh-client-ui-skill-explorer test`（122 通过）、
  `pnpm i18n:check`（15 个命名空间，zh/en/ru 1296 键对齐）、`pnpm docs:check`、
  `pnpm typecheck` 与 `pnpm libs:check` 均通过。
