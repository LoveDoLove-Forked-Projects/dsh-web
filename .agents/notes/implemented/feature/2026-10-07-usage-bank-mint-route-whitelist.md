# Agent Note: The Token Bank mints an explicit route whitelist

Status: implemented

## Problem

The Token 银行 tab minted whale yuan only from the DeepSeek official family, so a user whose largest provider was the `mimo` gateway route (`@mimo-codex/dsh-llm-mimo`) saw an empty note while the ledger plainly recorded their tokens (issue #1831). The old filter read:

```ts
if (!isDeepSeekProviderRoute(row.provider)) continue
```

That one predicate is the sole gate that excluded every non-official route.

## Decision

The mint family gains an explicit route-id whitelist. `packages/dsh-usage/src/client/voucher.ts` declares `EXTRA_MINT_ROUTE_IDS = ['mimo']` and a predicate `mintsWhaleYuan(provider)` that is `isDeepSeekProviderRoute(provider) || EXTRA_MINT_ROUTE_IDS.includes(provider)`. The summing function is renamed `deepseekVoucherData` to `voucherData`, because it no longer describes one family, and `UsageSectionCard.tsx` follows the rename.

The whitelist is a route id list, not an adapter family, on purpose. The [account-route note](../bug-fix/2026-09-30-usage-account-route-family-without-probe.md) established the standing rule that accounting decisions read `isDeepSeekProviderRoute()` while probing, credential fallback and alias folding read `adapterFor()`, so the two can never widen together. Minting is an accounting decision; putting `mimo` into an adapter would grant a gateway route the balance probe and the credential fallback it must not have.

`cost` stays gated on `isDeepSeekProviderRoute()` even though both predicates are true for the official family:

```ts
if (!mintsWhaleYuan(row.provider)) continue
tokens += totalTokens(row.totals)
calls += row.totals.calls
if (isDeepSeekProviderRoute(row.provider)) cost += row.totals.cost
```

MiMo ships no price book. Fold-time stamping already gives a `mimo` row `cost` 0, so summing the widened set adds 0 on real data; gating the line anyway makes the boundary structural instead of incidental, and makes it provable by a test whose fixture carries a non-zero `mimo` cost.

An empty list reduces `mintsWhaleYuan` to `isDeepSeekProviderRoute`, which is exactly how a profile that never runs MiMo behaves.

## Alternatives considered

- **A configurable `bankMintRoutes: string[]` setting.** Rejected: it widens the change surface into the config schema and the settings card for no present need, and a misconfigured route silently mints tokens against no price book. Revisit only when a second non-official route actually needs minting.
- **Adding `mimo` to the DEEPSEEK adapter's `familyOnlyIds`.** Rejected: `familyOnlyIds` models a route that authenticates without an API key but still belongs to the priced family. MiMo has no price book at all, so it would make the pricing paths treat it as DeepSeek.

## Consequences

- The `mimo` route id is an external contract owned by `@mimo-codex/dsh-llm-mimo`. If that package renames its id, the whitelist silently stops matching and the bank returns to its empty state. Accepted by design — it is the same reason the credential path stays untouched — and now pinned by a test.
- zh, en and ru bank copy (tab hint and empty state) names both sources; the ru mirror lives in `packages/dsh-i18n/src/client/ru/usage.ts`.
- Spend accounting is unchanged: MiMo mints tokens and calls and never enters the estimate, and observed spend still comes only from the DeepSeek official balance watch.
