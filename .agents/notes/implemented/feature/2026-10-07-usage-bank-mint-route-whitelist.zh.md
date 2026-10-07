# Agent Note: Token 银行铸造走显式路由白名单

Status: implemented

## Problem

Token 银行页签只从 DeepSeek 官方家族铸造鲸元，于是最大的 provider 恰好是 `mimo` 网关路由（`@mimo-codex/dsh-llm-mimo`）的用户，面对的是一张空票券，而台账里明明记着他的 tokens（issue #1831）。原过滤器是：

```ts
if (!isDeepSeekProviderRoute(row.provider)) continue
```

这一个谓词就是排除所有非官方路由的唯一闸门。

## Decision

铸造家族新增一条显式的路由 id 白名单。`packages/dsh-usage/src/client/voucher.ts` 声明 `EXTRA_MINT_ROUTE_IDS = ['mimo']` 与谓词 `mintsWhaleYuan(provider)`，后者为 `isDeepSeekProviderRoute(provider) || EXTRA_MINT_ROUTE_IDS.includes(provider)`。求和函数由 `deepseekVoucherData` 更名为 `voucherData`，因为它不再只描述一个家族；`UsageSectionCard.tsx` 跟随改名。

白名单用路由 id 而非 adapter 家族，是刻意的。[账号路由那条笔记](../bug-fix/2026-09-30-usage-account-route-family-without-probe.md) 立的常设规则是：记账类决策读 `isDeepSeekProviderRoute()`，而余额探测、凭据回退与 alias 折叠读 `adapterFor()`，两者不能一起变宽。铸造属于记账决策；把 `mimo` 塞进某个 adapter，等于白送它余额探测和凭据回退。

即使两个谓词对官方家族同时为真，`cost` 仍锁在 `isDeepSeekProviderRoute()` 上：

```ts
if (!mintsWhaleYuan(row.provider)) continue
tokens += totalTokens(row.totals)
calls += row.totals.calls
if (isDeepSeekProviderRoute(row.provider)) cost += row.totals.cost
```

MiMo 没有价目表。折叠时盖章本就让 `mimo` 行的 `cost` 为 0，所以在真实数据上对变宽集合求和加的仍是 0；仍然锁这一行，是把边界从「碰巧如此」变成结构性的，并且可以用一个带非零 `mimo` cost 的夹具测出来。

白名单为空时 `mintsWhaleYuan` 退化为 `isDeepSeekProviderRoute`，这正是从不跑 MiMo 的 profile 今天的 behaving。

## Alternatives considered

- **做成可配置的 `bankMintRoutes: string[]` 设置项。** 否决：它会把改动面扩到配置 schema 和设置卡，换不来当下任何需要，而配错的路由会在没有价目表的情况下静默铸出 tokens。等第二个非官方路由真的需要铸造时再议。
- **把 `mimo` 加进 DEEPSEEK adapter 的 `familyOnlyIds`。** 否决：`familyOnlyIds` 描述的是「不用 API key 但仍属于有价家族」的路由；MiMo 根本没有价目表，那会让定价路径把它当成 DeepSeek。

## Consequences

- `mimo` 路由 id 是 `@mimo-codex/dsh-llm-mimo` 拥有的外部契约。若该包改名，白名单会静默失配、票券退回空状态。这是刻意接受的——凭据路径因此才保持原样——并且已有测试钉住。
- zh / en / ru 的银行文案（页签提示与空状态）同时点名两个来源；ru 镜像位于 `packages/dsh-i18n/src/client/ru/usage.ts`。
- 消费口径不变：MiMo 铸造 tokens 与调用次数，从不进入消费估算，实测花费仍只来自 DeepSeek 官方余额观测。
