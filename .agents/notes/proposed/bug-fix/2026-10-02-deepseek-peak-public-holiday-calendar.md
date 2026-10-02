# Agent Note: DeepSeek peak pricing needs a Chinese public-holiday calendar this repository does not have

Status: proposed

## Problem

The reported symptom was that the estimated price comes out at roughly twice the real price, attributed to a "tiao xiu" (adjusted) workday falling on a weekend and being priced as off-peak. The investigation confirmed a real defect in [the peak-pricing note's clock](../implemented/feature/2026-08-29-usage-peak-pricing-and-announce-fix.md), but the direction of the error is the opposite one: the estimate is too **low** during a public holiday, and weekends are already handled the way the provider bills them.

The official rule ([api-docs.deepseek.com pricing page](https://api-docs.deepseek.com/quick_start/pricing/), footnote 2) reads: peak hours are Beijing time Monday-Friday 09:00-12:00 and 14:00-18:00, **excluding Chinese public holidays**; all other hours are off-peak, **including weekends and Chinese public holidays in full**.

Two things follow, and they pull in opposite directions:

- **A public-holiday date is not derivable from any rule.** The State Council publishes the arrangement per year, days shift, and a rule cannot guess them. The shipped clock gated only on `getUTCDay()`, so every Monday-Friday counted as peak, including a holiday morning billed at half. That is the half of the report that is real.
- **An adjusted-workday weekend is not a peak day.** The provider counts the calendar day, not the working schedule, and a Sunday designated as a workday is still off-peak in full. Chinese reporting on the 2026-09-19 clarification states this directly: adjusted workdays falling on a weekend, and Chinese public holidays, are both billed entirely as off-peak. The shipped `weekday >= 1 && weekday <= 5` gate already matches this, so "make adjusted workdays peak" would have introduced a new, opposite error.
A search of the repository and `node_modules` found no offline holiday dataset: no `chinese-days`, `workalendar`, `holiday-calendar`, or equivalent, and nothing in `pnpm-lock.yaml`; `@deepseek-ai/dsh-util-time` is IANA zone validation and canonicalization only. `src/core/` has no calendar helper. Inventing a table, or calling a network endpoint, are both ruled out by the repository rules.

## Proposal

1. **Ship the rule-derivable half now, which this change does.** `deepseekPeriodAt` and `deepseekModelSpend` take an optional `PublicHolidayCalendar` (`isPublicHoliday(date)` over Beijing-time `YYYY-MM-DD` strings) and route both the peak test and the next-boundary scan through one `isPeakDay()` predicate. The default is an empty calendar, so existing callers and all shipped behavior are unchanged.
2. **Keep the weekend rule as it is.** A Saturday or Sunday never becomes a peak day, whatever a calendar says. This is the published behavior, and the test that pins it is what stops a future "fix" from re-introducing the reported error.
3. **Decide the data source next, deliberately.** Until then the estimate still over-prices holiday windows, and the README keeps naming this a known limitation rather than pretending the estimate is exact.
4. **When a source is chosen, wire it at the fold site** (`src/host/usage-service.ts` `totalsFrom`) so a single calendar governs the estimate; do not scatter lookups through the pricing module.

## Context & Efficiency Impact

The calendar is a one-method interface defaulting to a constant, so the host half pays one function call per fold and the browser half nothing until a caller passes one. The `YYYY-MM-DD` string is the right granularity because a holiday is off-peak for the whole day, so no time-of-day component is ever needed. No schema, wire, or prompt cost; the interface is internal to `src/core/`.

## Alternatives considered

- **Treat adjusted workdays as peak days (the report as written).** Rejected on the evidence: the provider bills a designated workday that falls on a Saturday or Sunday entirely off-peak. Implementing it would have moved the estimate further from the bill, in the opposite direction, and would be the harder defect to notice because holidays are rarer than weekends.
- **Hardcode a 2026 (or any single-year) holiday table in the package.** Rejected: it silently rots. The arrangement is republished yearly and a stale table is worse than an empty one, because the empty calendar is a known, documented gap while a stale table looks authoritative. The proposed interface is where a reviewed table would live once someone owns updating it.
- **Fetch the calendar from a network endpoint at runtime.** Rejected: the package is a local ledger, the browser bundle purity gate rules out arbitrary runtime fetches, and an estimator that silently changes with network availability is not a deterministic cost record.
- **Add a third-party holiday dependency.** Not rejected on merit, but not taken here: no such package is currently installed, adding one is a supply-chain decision for a maintainer, and the network install is outside this task's authorization.
- **Derive holidays from the lunar calendar.** Rejected: a lunar date maps to a Gregorian holiday only after the State Council's own offset decision, so it is not a rule, it is a second calendar to maintain.

## Acceptance criteria

A source is chosen and the fold site passes a real calendar: a benchmark weekday inside a public holiday prices at the off-peak row, the same weekday outside one prices at the peak row, and the estimate stops diverging from the real bill across a holiday. The note then moves to `implemented/` and this repository keeps a small reviewed table, or documents the external source and its refresh trigger.

## Risks

- Until a calendar is wired, the estimate over-prices holiday windows by the same factor it over-prices nothing else: a holiday morning is billed at half and estimated at full. Users comparing a holiday day's estimate against the real bill will see the same "about X2" symptom, now correctly attributed.
- A wrong table is worse than no table, because a calendar that marks a normal weekday as a holiday under-prices a busy day. Any future table needs a test that a known ordinary week is untouched.
- The default-empty behavior means the gap is invisible in tests; a caller who forgets to pass a calendar gets a plausible but wrong number rather than an error.