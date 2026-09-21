/**
 * Integer money helpers. Everything the app treats as money is an integer
 * number of paise so that ₹1,000.50 can never drift into ₹1000.499999.
 */

export const PAISE_PER_RUPEE = 100

/** 1 share = 1000 milli-shares. */
export const SHARE_UNIT = 1000

/** Every winning share settles at ₹10. */
export const SETTLEMENT_PAISE = 10 * PAISE_PER_RUPEE

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE)
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** ₹1,000.50 */
export function formatINR(paise: number, options?: { whole?: boolean; signed?: boolean }) {
  const abs = Math.abs(paise)
  const formatter = options?.whole && abs % PAISE_PER_RUPEE === 0 ? inrWhole : inr
  const body = formatter.format(paiseToRupees(abs))
  if (options?.signed) return `${paise < 0 ? '-' : '+'}${body}`
  return paise < 0 ? `-${body}` : body
}

/** ₹4.5 — the compact per-share price style used on outcome buttons. */
export function formatSharePrice(pricePaise: number) {
  const rupees = pricePaise / PAISE_PER_RUPEE
  return `₹${rupees.toFixed(rupees < 10 ? 1 : 2)}`
}

/** ₹1.2L / ₹34.5K — compact volume style. */
export function formatCompactINR(paise: number) {
  const rupees = Math.round(paiseToRupees(paise))
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(2)}Cr`
  if (rupees >= 100_000) return `₹${(rupees / 100_000).toFixed(2)}L`
  if (rupees >= 1_000) return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${rupees}`
}

export function formatCount(value: number) {
  if (value >= 100_000) return `${(value / 100_000).toFixed(1)}L`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}

/** 64 → "64%" */
export function formatPercent(probabilityBps: number) {
  return `${Math.round(probabilityBps / 100)}%`
}

export function formatShares(milliShares: number) {
  const shares = milliShares / SHARE_UNIT
  return shares.toLocaleString('en-IN', {
    minimumFractionDigits: shares % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
}
