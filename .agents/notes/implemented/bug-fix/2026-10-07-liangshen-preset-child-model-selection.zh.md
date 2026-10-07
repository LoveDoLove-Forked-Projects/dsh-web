# Agent Note: 梁神预设的子 agent 模型选择开关

Status: implemented

## Problem

`packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` 的委派工具行照抄内置预设时漏掉了一个键：`tool-subagent` 与 `tool-subagent-fork` 都没有设 `modelSelectionSettings`。上游 `@deepseek-ai/dsh-tool-subagent` 把该键当作按行的开启开关（`modelSelectionSettings: z.boolean().default(false)`），而开启后的全部效果都挂在它上面：

- 委派工具不发布 `provider` / `model` / `reasoning_effort` 参数，显式指定子 agent 路由会在调用时抛 `child model selection is disabled for this tool instance`；
- 工具描述里永远不会出现 `Child LLM selection is optional` 这句，`list_subagent_models` 也从不注册，模型没有发现入口；
- 于是 Web 设置界面的子智能体模型选择开关在本预设下形同虚设，尽管宿主侧的服务是存在的（`subagent-model-selection-settings`，由官方 `dsh-web-app` 宿主 bundle 挂载）。

凡是带委派行的官方预设都在 spawn 行设了该键（`standard.patch.yml`、`ptc.patch.yml`、`cordis.patch.yml`），出厂的梁神清单是唯一的例外。

## Decision

`tool-subagent` 行带上 `modelSelectionSettings: true`，与内置 Standard、PTC、Cordis 预设对齐。`tool-subagent-fork` 行不带，而且不能带：

- 上游以固定名 `list_subagent_models` 注册发现工具（`packages/subagent/tool-subagent/src/list-models.ts` 的 `registerListSubagentModels`），注册进该行所合入的那个 scope；
- 预设 scope 的行是通过 `candidate.ctx.inject(...)` 按每个已组合 Agent 分别安装的，因此同一组合 scope 内的每一个开启行都会把同一个名字注册进同一个 Agent scope；
- 工具注册表拒绝同一 scope 内的同名重复注册：`NamedEntries.insert` 由其重复工厂抛错，消息为 `tool "list_subagent_models" is already registered in this scope`。第二个开启行因此会直接让会话组合失败，而不是多出一份能力。

因此出厂的不变式是：同一组合 scope 内只允许一行委派工具开启，而 fork 行恰恰是维护者会顺手补齐的那一行。这条约束写进了预设文件中该行旁边；`tests/preset-composition.test.ts` 也不再只钉 spawn 行的文本，而是在解析后的组合上（递归进入 group 行）按结构统计开启行，并额外做一次变异校验：给 fork 行注入第二个开关后统计结果必须变成两行，从而保证这道守卫不会空过。

在本包锁定的 cohort（`>=0.2.0-rc.2`）上核实过：schema、固定名注册与按 scope 安装路径，在 `0.2.0-rc.2` 源码与已发布的 `0.1.2-rc.1`、`0.1.7-rc.1` 包中完全一致。

## Testing

- `packages/dsh-liangshen/tests/preset-composition.test.ts` 在修复前失败（spawn 行断言，1 failed / 11 passed），修复后通过（12 passed）。
- 结构断言要求开启行 id 恰为 `['tool-subagent']`；同一断言在给 fork 行加上该键后必须报出 `['tool-subagent', 'tool-subagent-fork']`，保证守卫非空过。
- `pnpm --filter @linxin666/dsh-liangshen test` 与 `pnpm --filter @linxin666/dsh-liangshen typecheck` 通过；`pnpm docs:check`、`pnpm i18n:check`、`pnpm test:standards` 通过。
- 无 GUI 实测证据：预设改动需要完整重启 `dsh web` 才生效，运行中的宿主未被触碰。

## Alternatives considered

- spawn 行与 fork 行同时开启，让每个委派工具都能选路由。否决：这正是让整个会话以 `tool "list_subagent_models" is already registered in this scope` 失败的配置，而且 fork provider 并不会因此多得到 spawn 行没有的东西（它本身声明了 `agentOptions` 能力，所以能力不是阻塞点）。
- 在上游把发现工具的注册改为幂等，或改成按工具命名。这才是正解，但它属于 `@deepseek-ai/dsh-tool-subagent`，而本仓库从不修改 harness 或其 SDK 包。因此改为向上游提 issue；在其落地之前，由预设侧的注释与测试保证本地清单正确。
- 在预设里声明 `agentOptions` 块来钉住默认子 agent 路由（真实字段名是 `provider` / `model` / `reasoningEffort` / `maxTokens`，已在安装的 schema 中核实），而不开启模型侧选择。否决：它并不能修好 issue 指向的设置开关，反而会为每次委派强行钉死一条子路由。该键保持不设置；对确实想要固定路由的运维者，它仍是另一个独立可选项。
- 不加开关、只在文档里写明限制。否决：这等于把已报告的缺陷留在出厂预设里，而它的上游对照物本来就带着这个键。

## Consequences

- 梁神模式下 Web 设置界面的子 agent 模型选择开关真正生效：宿主设置开启后，模型能在 `subagent` 上看到路由参数并调用 `list_subagent_models`，显式路由还会按会话允许清单校验。
- 该开关是按行而非按预设的，所以在上游让发现工具的注册幂等之前，fork 行仍然沿用父会话路由。需要可 fork 的子 agent 走另一条路由的能力要等上游修复。
- 预设文件里留下了一条比这个 issue 活得更久的注释：同一 scope 只允许一行 opt-in，并写明它防住的失败，让下一个维护者不会把 fork 行缺的那个键当成疏漏。
