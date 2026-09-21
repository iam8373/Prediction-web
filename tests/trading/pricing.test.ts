import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MAX_TRADE_PAISE, MIN_TRADE_PAISE, calculateNextYesPrice, executionPricePaise, priceImpactPaise, quoteBuy, quoteSell } from '@/lib/trading/pricing'
import { SETTLEMENT_PAISE } from '@/lib/money'

/**
 * Pricing engine.
 *
 * The property that matters here is economic, not cosmetic: no sequence of
 * trades may end with more money than it started with. Buying used to fill at the
 * mid and then push the price up, so selling straight back filled at the higher
 * price and the pair paid out — repeatedly, for any amount, until the market's
 * liquidity was gone.
 */

/** Deterministic PRNG so a failure can be reproduced exactly. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1))
}

describe('quote spread', () => {
  test('a buy fills above the mid and a sell below it', () => {
    const liquidity = 100_000
    const mid = 500
    assert.equal(executionPricePaise(mid, 'buy', 10_000, liquidity), 510)
    assert.equal(executionPricePaise(mid, 'sell', 10_000, liquidity), 490)
    assert.ok(quoteBuy(10_000, mid, liquidity).pricePaise > mid)
    assert.ok(quoteSell(10_000, mid, 500, liquidity).pricePaise < mid)
  })

  test('slippage grows with order size and shrinks with liquidity', () => {
    assert.ok(priceImpactPaise(50_000, 100_000) > priceImpactPaise(5_000, 100_000))
    assert.ok(priceImpactPaise(50_000, 1_000_000) < priceImpactPaise(50_000, 100_000))
  })

  test('slippage is always charged, and never more than the cap', () => {
    // A minimum of one paise is what makes a round trip strictly worse than doing
    // nothing, rather than merely break-even.
    assert.equal(priceImpactPaise(0, 100_000), 1)
    assert.equal(priceImpactPaise(1, 1_000_000_000), 1)
    assert.equal(priceImpactPaise(Number.MAX_SAFE_INTEGER, 0), 60)
  })

  test('prices stay inside the range a share can settle at', () => {
    // Above ₹9.99 a buy would pay more than the maximum payout; below ₹0.01 a
    // sell would pay less than nothing. The market price is clamped by the same
    // rule, so a clamped move can never overshoot the price an order filled at.
    assert.equal(executionPricePaise(999, 'buy', 10_000_000, 0), 999)
    assert.equal(executionPricePaise(1, 'sell', 10_000_000, 0), 1)
    assert.equal(calculateNextYesPrice(999, 'yes', 'buy', 10_000_000, 0), 999)
    assert.equal(calculateNextYesPrice(1, 'yes', 'sell', 10_000_000, 0), 1)
    // And the clamp is symmetric across the pair: the two outcomes always sum to
    // the settlement value, so one cannot be priced at the other's expense.
    for (const mid of [1, 250, 500, 750, 998, 999]) {
      const moved = calculateNextYesPrice(mid, 'yes', 'buy', 10_000, 0)
      assert.ok(moved >= 1 && moved <= 999)
    }
  })
})

describe('risk-free round trips (the money bug)', () => {
  test('a 10,000 buy and an immediate sell returns less than it paid', () => {
    // Regression: with ₹1,000 of liquidity, ₹100 in and straight out returned
    // ₹101.96 while the price ended exactly where it started — repeatable.
    const liquidity = 100_000
    const mid = 500
    const amount = 10_000

    const buy = quoteBuy(amount, mid, liquidity)
    assert.equal(buy.milliShares, 19_607)
    assert.equal(buy.pricePaise, 510)

    const midAfterBuy = calculateNextYesPrice(mid, 'yes', 'buy', amount, liquidity)
    assert.equal(midAfterBuy, 510)

    const sell = quoteSell(buy.milliShares, midAfterBuy, buy.pricePaise, liquidity)
    assert.equal(sell.netValuePaise, 9_803)

    // The price does return to where it started. The money does not — which is
    // the whole point: before the fix this returned 10,196.
    assert.equal(calculateNextYesPrice(midAfterBuy, 'yes', 'sell', sell.markValuePaise, liquidity), mid)
    assert.ok(sell.netValuePaise < amount, `round trip returned ${sell.netValuePaise} for ${amount} paid`)
  })

  test('no sequence of alternating round trips can end up ahead', () => {
    const random = mulberry32(0x5eed_1234)
    const STARTING_CASH = 5_000_000

    for (let scenario = 0; scenario < 250; scenario += 1) {
      const liquidity = randomInt(random, 0, 5_000_000)
      const amount = randomInt(random, MIN_TRADE_PAISE, MAX_TRADE_PAISE)
      let mid = randomInt(random, 1, SETTLEMENT_PAISE - 1)
      let cash = STARTING_CASH
      let heldMilliShares = 0

      for (let trip = 0; trip < 50; trip += 1) {
        const cashBeforeTrip = cash
        const midBeforeTrip = mid

        const buy = quoteBuy(amount, mid, liquidity)
        if (buy.milliShares <= 0) break
        cash -= buy.amountPaise
        heldMilliShares += buy.milliShares
        mid = calculateNextYesPrice(mid, 'yes', 'buy', buy.amountPaise, liquidity)

        const sell = quoteSell(heldMilliShares, mid, buy.pricePaise, liquidity)
        cash += sell.netValuePaise
        heldMilliShares = 0
        mid = calculateNextYesPrice(mid, 'yes', 'sell', sell.markValuePaise, liquidity)

        assert.ok(
          cash <= cashBeforeTrip,
          `scenario ${scenario} trip ${trip} (mid ${midBeforeTrip}, liquidity ${liquidity}, amount ${amount}): ` +
            `cash went ${cashBeforeTrip} -> ${cash}`,
        )
      }

      assert.equal(heldMilliShares, 0, 'every scenario ends flat, not holding a position')
      assert.ok(cash <= STARTING_CASH, `scenario ${scenario} ended with ${cash} from ${STARTING_CASH}`)
    }
  })

  test('both outcomes are covered, not just Yes', () => {
    const liquidity = 120_000
    let yesMid = 400
    const noMid = () => SETTLEMENT_PAISE - yesMid

    for (const side of ['yes', 'no'] as const) {
      const mid = side === 'yes' ? yesMid : noMid()
      const buy = quoteBuy(20_000, mid, liquidity)
      const yesAfterBuy = calculateNextYesPrice(yesMid, side, 'buy', 20_000, liquidity)
      const outcomeMidAfterBuy = side === 'yes' ? yesAfterBuy : SETTLEMENT_PAISE - yesAfterBuy
      const sell = quoteSell(buy.milliShares, outcomeMidAfterBuy, buy.pricePaise, liquidity)

      assert.ok(
        sell.netValuePaise < 20_000,
        `buying ${side} with 20,000 and selling straight back returned ${sell.netValuePaise}`,
      )
      yesMid = yesAfterBuy
    }
  })

  test('a sell after a genuine price rise still books a profit', () => {
    // The fix must not tax ordinary trading: the position was bought at 500, the
    // market moved to 700 on its own, and selling then is a real gain.
    const sell = quoteSell(20_000, 700, 500, 100_000)
    assert.ok(sell.pnlPaise > 0, `expected a profit, got ${sell.pnlPaise}`)
    assert.ok(sell.netValuePaise > 10_000)
  })
})
