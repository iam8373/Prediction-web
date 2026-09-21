import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isSupportedCurrency,
  MAX_DEPOSIT_PAISE,
  MAX_WITHDRAWAL_PAISE,
  MIN_DEPOSIT_PAISE,
  MIN_WITHDRAWAL_PAISE,
  normalizeProviderAmountToPaise,
  splitPaymentAmount,
  SUPPORTED_CURRENCY,
} from '../../lib/payments/limits.ts'

describe('payment limits and currency', () => {
  it('supports exactly one currency', () => {
    assert.equal(SUPPORTED_CURRENCY, 'INR')
    assert.equal(isSupportedCurrency('INR'), true)
    assert.equal(isSupportedCurrency('USD'), false)
    assert.equal(isSupportedCurrency(undefined), false)
  })

  it('keeps the published deposit and withdrawal bands', () => {
    assert.equal(MIN_DEPOSIT_PAISE, 10_000)
    assert.equal(MAX_DEPOSIT_PAISE, 20_000_000)
    assert.equal(MIN_WITHDRAWAL_PAISE, 20_000)
    assert.equal(MAX_WITHDRAWAL_PAISE, 20_000_000)
  })
})

describe('provider amount normalisation', () => {
  it('converts major units into integer paise', () => {
    assert.equal(normalizeProviderAmountToPaise(10.5, 'rupees'), 1_050)
    assert.equal(normalizeProviderAmountToPaise(100, 'rupees'), 10_000)
  })

  it('passes paise through untouched', () => {
    assert.equal(normalizeProviderAmountToPaise(10_500, 'paise'), 10_500)
  })

  it('refuses amounts that cannot be represented exactly', () => {
    // ₹10.005 is not a whole number of paise — reject instead of rounding.
    assert.throws(() => normalizeProviderAmountToPaise(10.005, 'rupees'), /PROVIDER_AMOUNT_INVALID/)
    assert.throws(() => normalizeProviderAmountToPaise(1.5, 'paise'), /PROVIDER_AMOUNT_INVALID/)
    assert.throws(() => normalizeProviderAmountToPaise(-100, 'paise'), /PROVIDER_AMOUNT_INVALID/)
    assert.throws(() => normalizeProviderAmountToPaise(Number.NaN, 'paise'), /PROVIDER_AMOUNT_INVALID/)
    assert.throws(() => normalizeProviderAmountToPaise(Number.POSITIVE_INFINITY, 'paise'), /PROVIDER_AMOUNT_INVALID/)
  })

  it('never lets float drift shift a balance', () => {
    // 0.1 + 0.2 rupees is 30.000000000000004 paise as a float.
    assert.equal(normalizeProviderAmountToPaise(0.1 + 0.2, 'rupees'), 30)
    // ₹1,234.56 * 100 is 123455.99999999999 as a float.
    assert.equal(normalizeProviderAmountToPaise(1_234.56, 'rupees'), 123_456)
    assert.equal(normalizeProviderAmountToPaise(19_999.99, 'rupees'), 1_999_999)
  })
})

describe('fee split', () => {
  it('represents requested, provider, fee and net explicitly', () => {
    assert.deepEqual(splitPaymentAmount(50_000), {
      requestedPaise: 50_000,
      providerPaise: 50_000,
      feePaise: 0,
      netPaise: 50_000,
    })
  })

  it('subtracts an explicit fee from the wallet credit', () => {
    assert.deepEqual(splitPaymentAmount(50_000, 1_000), {
      requestedPaise: 50_000,
      providerPaise: 50_000,
      feePaise: 1_000,
      netPaise: 49_000,
    })
  })

  it('rejects nonsensical amounts', () => {
    assert.throws(() => splitPaymentAmount(0), /PAYMENT_AMOUNT_INVALID/)
    assert.throws(() => splitPaymentAmount(-1), /PAYMENT_AMOUNT_INVALID/)
    assert.throws(() => splitPaymentAmount(100.5), /PAYMENT_AMOUNT_INVALID/)
    assert.throws(() => splitPaymentAmount(1_000, 2_000), /PAYMENT_AMOUNT_INVALID/)
  })
})
