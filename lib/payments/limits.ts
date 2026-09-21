/**
 * Payment-domain constants. This is the single source of truth for the
 * currency the platform accepts and for the deposit/withdrawal limits that
 * both the Zod schemas and the server-side payment service enforce.
 *
 * Money stays an integer number of paise end to end (see `lib/money.ts`).
 * Provider payloads are normalized into paise *before* any wallet mutation.
 */

/** The only currency this deployment supports. Multi-currency is out of scope. */
export const SUPPORTED_CURRENCY = 'INR'

export const MIN_DEPOSIT_PAISE = 10_000 // ₹100
export const MAX_DEPOSIT_PAISE = 20_000_000 // ₹2,00,000
export const MIN_WITHDRAWAL_PAISE = 20_000 // ₹200
export const MAX_WITHDRAWAL_PAISE = 20_000_000 // ₹2,00,000

/** Methods the checkout UI can offer. No card/UPI credentials are ever stored. */
export const DEPOSIT_METHODS = ['upi', 'netbanking', 'demo'] as const
export type DepositMethod = (typeof DEPOSIT_METHODS)[number]

export function isSupportedCurrency(code: string | undefined | null): code is string {
  return code === SUPPORTED_CURRENCY
}

/** Thrown as a coded error string so route handlers can map it to an HTTP status. */
export const UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY'

/**
 * Convert a value reported by a payment provider into integer paise.
 *
 * Providers can report either minor units (paise) or major units (rupees);
 * the adapter declares which one it uses. Anything that cannot be represented
 * exactly as a whole number of paise is rejected rather than rounded, so a
 * provider bug can never silently shift a balance.
 */
/**
 * Convert a value reported by a payment provider into integer paise.
 *
 * Providers can report either minor units (paise) or major units (rupees); the
 * adapter declares which one it uses. Binary floating point cannot represent
 * every decimal amount exactly (₹1,234.56 is 123455.99999999999 when multiplied
 * by 100), so an amount is accepted only when it lands within a hair of a whole
 * number of paise — anything genuinely ambiguous (e.g. ₹10.005) is rejected
 * rather than rounded, so a provider bug can never silently shift a balance.
 */
export function normalizeProviderAmountToPaise(
  amount: number,
  unit: 'paise' | 'rupees',
): number {
  if (!Number.isFinite(amount)) throw new Error('PROVIDER_AMOUNT_INVALID')
  const raw = unit === 'paise' ? amount : amount * 100
  const paise = Math.round(raw)
  if (Math.abs(raw - paise) > 1e-6) throw new Error('PROVIDER_AMOUNT_INVALID')
  if (paise < 0) throw new Error('PROVIDER_AMOUNT_INVALID')
  return paise
}

/** Splits a requested amount into provider amount, fee and net wallet effect. */
export function splitPaymentAmount(amountPaise: number, feePaise = 0) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new Error('PAYMENT_AMOUNT_INVALID')
  if (!Number.isInteger(feePaise) || feePaise < 0) throw new Error('PAYMENT_AMOUNT_INVALID')
  if (feePaise > amountPaise) throw new Error('PAYMENT_AMOUNT_INVALID')
  return {
    requestedPaise: amountPaise,
    providerPaise: amountPaise,
    feePaise,
    netPaise: amountPaise - feePaise,
  }
}
