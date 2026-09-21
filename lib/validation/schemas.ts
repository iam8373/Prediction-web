import { z } from 'zod'

import {
  DEPOSIT_METHODS,
  MAX_DEPOSIT_PAISE,
  MAX_WITHDRAWAL_PAISE,
  MIN_DEPOSIT_PAISE,
  MIN_WITHDRAWAL_PAISE,
} from '@/lib/payments/limits'
import { MAX_TRADE_PAISE, MIN_TRADE_PAISE } from '@/lib/trading/pricing'

/**
 * Shared schemas. The same definitions are reused by client forms today and by
 * the route handlers once the API layer is wired up, so the browser can never
 * be the only thing validating a financial request.
 */

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10 digit Indian mobile number')

export const otpSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6 digit code')

export const emailSchema = z.string().trim().email('Enter a valid email address')

export const loginSchema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
  invitationCode: z
    .string()
    .trim()
    .max(12, 'Invitation codes are at most 12 characters')
    .optional()
    .or(z.literal('')),
})

/**
 * Identifiers are opaque server-issued strings. They are length-bounded so a
 * caller cannot use an id field to push megabytes into a query or a log line,
 * and `.int()`/`.max()` on money also rejects NaN and Infinity.
 */
const idSchema = z.string().trim().min(1, 'Required').max(120, 'That identifier is not valid')

/** 1e9 shares (in milli-shares) is far beyond any real position. */
const MAX_MILLI_SHARES = 1_000_000_000_000

export const tradeSchema = z.object({
  marketId: idSchema,
  outcomeId: idSchema,
  side: z.enum(['buy', 'sell']),
  amountPaise: z
    .number()
    .int('Amount must be a whole number of paise')
    .min(MIN_TRADE_PAISE, 'Minimum trade is ₹1')
    .max(MAX_TRADE_PAISE, 'Maximum trade is ₹10,000'),
})

export const sellSchema = z.object({
  marketId: idSchema,
  outcomeId: idSchema,
  milliShares: z
    .number()
    .int('Shares must be a whole number')
    .positive('Select how many shares to sell')
    .max(MAX_MILLI_SHARES, 'That amount of shares is not valid'),
})

/**
 * Payment request schemas. Limits and currency come from `lib/payments/limits`
 * so the browser validates exactly what the server enforces — the server never
 * trusts a browser-supplied total.
 */
export const depositSchema = z.object({
  amountPaise: z
    .number()
    .int()
    .min(MIN_DEPOSIT_PAISE, 'Minimum deposit is ₹100')
    .max(MAX_DEPOSIT_PAISE, 'Maximum deposit is ₹2,00,000'),
  method: z.enum(DEPOSIT_METHODS).default('demo'),
})

export const withdrawSchema = z.object({
  amountPaise: z
    .number()
    .int()
    .min(MIN_WITHDRAWAL_PAISE, 'Minimum withdrawal is ₹200')
    .max(MAX_WITHDRAWAL_PAISE, 'Maximum withdrawal is ₹2,00,000'),
  destination: z
    .string()
    .trim()
    .min(4, 'Enter the UPI ID that should receive the payout')
    .max(64),
})

export const adminWithdrawalActionSchema = z.object({
  paymentId: idSchema,
  action: z.enum(['complete', 'fail', 'cancel']),
  reason: z.string().trim().max(160).optional().or(z.literal('')),
})

export const reconciliationRunSchema = z.object({
  provider: z.string().trim().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  sinceDays: z.number().int().min(1).max(365).optional().default(30),
})

/** Dev/sandbox only: drives a simulated provider result through the real webhook path. */
export const sandboxSimulationSchema = z.object({
  paymentId: idSchema,
  outcome: z.enum(['succeeded', 'failed']),
})

/** Admin-triggered bounded re-check of payments stuck pending/processing. */
export const paymentRecheckSchema = z.object({
  provider: z.string().trim().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(100).optional().default(25),
  /** Skip the backoff — the admin is deliberately asking now. */
  force: z.boolean().optional().default(true),
})

/** Admin-triggered retention purge (dry run by default). */
export const retentionPurgeSchema = z.object({
  dryRun: z.boolean().optional().default(true),
})

export const marketFormSchema = z
  .object({
    question: z.string().trim().min(12, 'Ask a full question').max(160),
    description: z.string().trim().min(20, 'Describe how this market works').max(600),
    categoryId: idSchema.pipe(z.string().min(1, 'Pick a category')),
    yesLabel: z.string().trim().min(1, 'Name the Yes outcome').max(16),
    noLabel: z.string().trim().min(1, 'Name the No outcome').max(16),
    opensAt: z.string().min(1, 'Pick an opening date'),
    closesAt: z.string().min(1, 'Pick a closing date'),
    resolvesAt: z.string().min(1, 'Pick a resolution date'),
    resolutionCriteria: z.string().trim().min(20, 'Explain how this resolves').max(600),
    source: z.string().trim().min(3, 'Name the source of truth').max(120),
    initialLiquidityRupees: z
      .number()
      .int()
      .min(1_000, 'Seed at least ₹1,000 of liquidity')
      .max(10_000_000),
    initialYesProbability: z
      .number()
      .int()
      .min(1, 'Probability must be between 1% and 99%')
      .max(99),
    status: z.enum(['open', 'paused']),
  })
  .refine((v) => new Date(v.closesAt).getTime() > new Date(v.opensAt).getTime(), {
    message: 'A market cannot close before it opens',
    path: ['closesAt'],
  })
  .refine((v) => new Date(v.resolvesAt).getTime() >= new Date(v.closesAt).getTime(), {
    message: 'Resolution must be on or after the close',
    path: ['resolvesAt'],
  })

export const adminRefundSchema = z.object({
  transactionId: idSchema,
  reason: z.string().trim().max(160).optional().or(z.literal('')),
})

export type LoginInput = z.infer<typeof loginSchema>
export type TradeInput = z.infer<typeof tradeSchema>
export type SellInput = z.infer<typeof sellSchema>
export type DepositInput = z.infer<typeof depositSchema>
export type WithdrawInput = z.infer<typeof withdrawSchema>
export type MarketFormInput = z.infer<typeof marketFormSchema>
export type AdminRefundInput = z.infer<typeof adminRefundSchema>
export type AdminWithdrawalActionInput = z.infer<typeof adminWithdrawalActionSchema>
export type ReconciliationRunInput = z.infer<typeof reconciliationRunSchema>
export type SandboxSimulationInput = z.infer<typeof sandboxSimulationSchema>
export type PaymentRecheckInput = z.infer<typeof paymentRecheckSchema>
export type RetentionPurgeInput = z.infer<typeof retentionPurgeSchema>

/** Turns a ZodError into a `{ field: message }` map for form rendering. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form'
    if (!out[key]) out[key] = issue.message
  }
  return out
}
