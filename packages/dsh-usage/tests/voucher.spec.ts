import { describe, expect, it } from 'vitest'
import { EXTRA_MINT_ROUTE_IDS, faceValue, formatDay, formatDenomination, mintsWhaleYuan, voucherData, voucherSerial, TOKENS_PER_WHALE_YUAN } from '../src/client/voucher.ts'
import { adapterFor } from '../src/core/adapters.ts'
import { emptyTotals, type UsageProviderSummary, type UsageWindowSummary } from '../src/core/types.ts'

/**
 * The voucher's pure face: mint family (DeepSeek official + MiMo) summation
 * over a usage window, the 1,000,000:1 whale-yuan exchange, the banknote
 * denomination formatting, the deterministic serial, and the observed-since
 * day. The canvas draw itself is composition, verified visually.
 */

function row(provider: string, inputTokens: number, calls = 1, cost = 0): UsageProviderSummary {
  return { provider, totals: { ...emptyTotals(), inputTokens, calls, cost }, models: [] }
}

function windowOf(providers: UsageProviderSummary[]): UsageWindowSummary {
  return { from: '2025-12-01', to: '2026-01-01', totals: emptyTotals(), providers }
}

describe('voucherData', () => {
  it('returns undefined without a window (older host) or without mint-family usage', () => {
    expect(voucherData(undefined)).toBeUndefined()
    expect(voucherData(windowOf([row('kimi-coding', 100)]))).toBeUndefined()
    expect(voucherData(windowOf([]))).toBeUndefined()
  })

  it('sums the whole official family across route aliases and ignores other providers', () => {
    const data = voucherData(windowOf([
      row('deepseek', 100_000, 3, 1.25),
      row('deepseek-official', 50_000, 2, 0.75),
      row('kimi-coding', 999_999, 40, 0),
    ]))
    expect(data).toMatchObject({ tokens: 150_000, calls: 5, cost: 2, from: '2025-12-01', to: '2026-01-01' })
  })

  // #1772: the account route minted nowhere, so a user signed in to a DeepSeek
  // account saw a permanently empty bank while spending against it.
  it('user on the signed-in account route sees their tokens mint alongside the key routes', () => {
    // Given a usage window holding the account route, an official key route,
    // and an unrelated provider
    const data = voucherData(windowOf([
      row('deepseek-account', 12_000_000, 40, 3.5),
      row('deepseek-official', 50_000, 2, 0.75),
      row('kimi-coding', 999_999, 40, 0),
    ]))
    // When the bank mints from the family
    // Then the account route counts toward the face value, spend and calls,
    // and the unrelated provider still never mints
    expect(data).toMatchObject({ tokens: 12_050_000, calls: 42, cost: 4.25 })
  })

  // #1831: the MiMo gateway route minted nowhere, so a profile whose default
  // route is MiMo (its largest provider in the ledger) saw an empty bank.
  it('user on the MiMo gateway route sees their tokens mint beside the official family', () => {
    // Given a usage window holding the MiMo route, one official route, and an
    // unrelated provider; the MiMo row also carries a non-zero cost, which a
    // priced host would never stamp on it (MiMo has no price book) and which
    // the bank must therefore still refuse to fold into the spend estimate
    const data = voucherData(windowOf([
      row('mimo', 8_000_000, 24, 9.99),
      row('deepseek-official', 50_000, 2, 0.75),
      row('kimi-coding', 999_999, 40, 0),
    ]))
    // When the bank mints from the mint family
    // Then MiMo tokens and calls count toward the face value, the spend line
    // stays the priced family's, and the unrelated provider still never mints
    expect(data).toMatchObject({ tokens: 8_050_000, calls: 26, cost: 0.75 })
  })

  it('counts cache tokens as minted whale yuan', () => {
    const data = voucherData(windowOf([{
      provider: 'deepseek',
      totals: { ...emptyTotals(), inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, calls: 1 },
      models: [],
    }]))
    expect(data?.tokens).toBe(100)
  })
})

describe('mintsWhaleYuan', () => {
  // #1772 split: the mint predicate widens the bank only; every credential and
  // probe decision keeps reading adapterFor(), which must stay blind to the
  // whitelist so the two can never widen together.
  it('user sees the MiMo route mint beside the official family and no unrelated route mint', () => {
    // Given the mint route whitelist
    // When the mint predicate is asked about each provider route
    // Then the whitelist routes and the whole official family mint, and no other route does
    expect(EXTRA_MINT_ROUTE_IDS).toEqual(['mimo'])
    expect(mintsWhaleYuan('mimo')).toBe(true)
    expect(mintsWhaleYuan('deepseek')).toBe(true)
    expect(mintsWhaleYuan('deepseek-official')).toBe(true)
    expect(mintsWhaleYuan('deepseek-account')).toBe(true)
    expect(mintsWhaleYuan('kimi-coding')).toBe(false)
    expect(mintsWhaleYuan('unknown-provider')).toBe(false)
  })

  it('user keeps a whitelisted mint route out of the credential and balance-probe paths', () => {
    // Given every route id on the mint whitelist
    // When the adapter table is asked which of them it can probe
    // Then no adapter claims any of them, so minting reaches no credential or balance endpoint
    for (const id of EXTRA_MINT_ROUTE_IDS) expect(adapterFor(id), id).toBeUndefined()
  })
})

describe('faceValue (1,000,000 tokens = 1 whale yuan)', () => {
  it('exchanges at the anti-inflation rate and rounds to whole yuan', () => {
    expect(TOKENS_PER_WHALE_YUAN).toBe(1_000_000)
    expect(faceValue(1_234_567_890)).toBe(1235)
    expect(faceValue(1_086_000_000_000)).toBe(1_086_000)
    expect(faceValue(1_000_000)).toBe(1)
  })

  it('keeps the smallest denomination at 1 instead of a zero note', () => {
    expect(faceValue(42)).toBe(1)
    expect(faceValue(999_999)).toBe(1)
  })
})

describe('formatDenomination', () => {
  it('prints full digits with thousands separators', () => {
    expect(formatDenomination(0)).toBe('0')
    expect(formatDenomination(999)).toBe('999')
    expect(formatDenomination(1234)).toBe('1,234')
    expect(formatDenomination(1_234_567)).toBe('1,234,567')
    expect(formatDenomination(1_234_567_890)).toBe('1,234,567,890')
  })

  it('rounds fractional accumulations away', () => {
    expect(formatDenomination(1234.6)).toBe('1,235')
  })
})

describe('voucherSerial', () => {
  it('derives a deterministic zero-padded serial from the face value', () => {
    expect(voucherSerial(42)).toBe('000000042')
    expect(voucherSerial(123_456_789)).toBe('123456789')
    expect(voucherSerial(1_000_000_000)).toBe('000000000')
    expect(voucherSerial(1_000_000_042)).toBe('000000042')
  })
})

describe('formatDay', () => {
  it('formats the observation start as a deterministic local day', () => {
    expect(formatDay(new Date(2026, 0, 2, 12).getTime())).toBe('2026-01-02')
    expect(formatDay(new Date(2026, 8, 10, 7, 30).getTime())).toBe('2026-09-10')
  })
})
