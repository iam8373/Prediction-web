'use client'

import { AlertTriangle, CheckCircle2, PauseCircle, PlusCircle, RotateCcw, ShieldCheck, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { PaymentOperations } from '@/components/admin/payment-operations'
import { AppShell } from '@/components/layout/app-shell'
import { AuthGate } from '@/components/trading/auth-gate'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Badge, Card, EmptyState, Field, inputClass, SectionHeading, StatTile } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { categories } from '@/lib/data/categories'
import { DEMO_NOW } from '@/lib/data/demo-config'
import { formatDateTime, toLocalInputValue } from '@/lib/date'
import { formatCompactINR, formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'
import { fieldErrors, marketFormSchema, type MarketFormInput } from '@/lib/validation/schemas'
import type { AdminTransaction, Market } from '@/types'

const emptyForm: MarketFormInput = {
  question: '',
  description: '',
  categoryId: categories[0].id,
  yesLabel: 'Yes',
  noLabel: 'No',
  opensAt: toLocalInputValue(DEMO_NOW),
  closesAt: toLocalInputValue(DEMO_NOW + 7 * 86_400_000),
  resolvesAt: toLocalInputValue(DEMO_NOW + 7 * 86_400_000 + 2 * 3_600_000),
  resolutionCriteria: '',
  source: '',
  initialLiquidityRupees: 10_000,
  initialYesProbability: 50,
  status: 'open',
}

export default function AdminPage() {
  const user = useAppStore((s) => s.user)
  const markets = useAppStore((s) => s.markets)
  const createMarket = useAppStore((s) => s.createMarket)
  const resolveMarket = useAppStore((s) => s.resolveMarket)
  const setMarketStatus = useAppStore((s) => s.setMarketStatus)
  const { toast } = useToast()

  const adminTransactions = useAppStore((s) => s.adminTransactions)
  const adminTransactionsLoading = useAppStore((s) => s.adminTransactionsLoading)
  const adminFetchTransactions = useAppStore((s) => s.adminFetchTransactions)
  const adminRefundTransaction = useAppStore((s) => s.adminRefundTransaction)

  const [form, setForm] = useState<MarketFormInput>(emptyForm)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingResolution, setPendingResolution] = useState<{ market: Market; outcomeId: string } | null>(null)
  const [refundQuery, setRefundQuery] = useState('')
  const [pendingRefund, setPendingRefund] = useState<AdminTransaction | null>(null)
  const [refundReason, setRefundReason] = useState('')
  const [refundBusy, setRefundBusy] = useState(false)

  useEffect(() => {
    if (!user?.isAdmin) return
    const timer = setTimeout(() => adminFetchTransactions(refundQuery), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isAdmin, refundQuery])

  const stats = useMemo(() => ({
    volumePaise: markets.reduce((sum, market) => sum + market.volumePaise, 0),
    openMarkets: markets.filter((market) => market.status === 'open').length,
    resolvedMarkets: markets.filter((market) => market.status === 'resolved').length,
    feesPaise: Math.round(markets.reduce((sum, market) => sum + market.volumePaise, 0) * 0.02),
  }), [markets])
  const manageableMarkets = markets.filter((m) => m.status !== 'resolved')

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in with an admin account to manage markets." />
      </AppShell>
    )
  }
  if (!user.isAdmin) {
    return (
      <AppShell>
        <EmptyState
          icon={<AlertTriangle className="size-8" />}
          title="Admin access required"
          description="Your account does not have permission to view this page."
        />
      </AppShell>
    )
  }

  function update<K extends keyof MarketFormInput>(key: K, value: MarketFormInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submitMarket() {
    const parsed = marketFormSchema.safeParse(form)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    setErrors({})
    const result = await createMarket(parsed.data)
    if (result.ok) {
      toast({ title: 'Market created', description: parsed.data.question, tone: 'success' })
      setForm(emptyForm)
    } else {
      toast({ title: 'Could not create market', description: result.error, tone: 'error' })
    }
  }

  async function confirmResolve() {
    if (!pendingResolution) return
    const { market, outcomeId } = pendingResolution
    const result = await resolveMarket(market.id, outcomeId)
    setPendingResolution(null)
    if (result.ok) {
      toast({ title: 'Market resolved', description: market.question, tone: 'success' })
    } else {
      toast({ title: 'Could not resolve', description: result.error, tone: 'error' })
    }
  }

  async function confirmRefund() {
    if (!pendingRefund) return
    setRefundBusy(true)
    const result = await adminRefundTransaction(pendingRefund.id, refundReason.trim())
    setRefundBusy(false)
    setPendingRefund(null)
    setRefundReason('')
    if (result.ok) {
      toast({ title: pendingRefund.type === 'withdrawal' ? 'Withdrawal cancelled' : 'Deposit refunded', description: `${pendingRefund.userName} · ${formatINR(Math.abs(pendingRefund.amountPaise))}`, tone: 'success' })
    } else {
      toast({ title: 'Could not process refund', description: result.error, tone: 'error' })
    }
  }

  async function handleStatusChange(market: Market, status: 'open' | 'paused' | 'closed') {
    const result = await setMarketStatus(market.id, status)
    if (result.ok) {
      toast({
        title: status === 'open' ? 'Market reopened' : status === 'paused' ? 'Market paused' : 'Market closed',
        description: market.question,
        tone: 'success',
      })
    } else {
      toast({ title: 'Could not update market', description: result.error, tone: 'error' })
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Admin</h1>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Platform volume" value={formatCompactINR(stats.volumePaise)} />
          <StatTile label="Open markets" value={`${stats.openMarkets}`} />
          <StatTile label="Resolved markets" value={`${stats.resolvedMarkets}`} />
          <StatTile label="Platform fees" value={formatCompactINR(stats.feesPaise)} />
        </div>

        <section>
          <SectionHeading title="Create market" icon={<PlusCircle className="size-4" />} />
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Question" htmlFor="question" error={errors.question}>
                <input
                  id="question"
                  className={inputClass}
                  value={form.question}
                  onChange={(e) => update('question', e.target.value)}
                  placeholder="Will ... ?"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="description" error={errors.description}>
                <textarea
                  id="description"
                  className={`${inputClass} h-20`}
                  value={form.description}
                  onChange={(e) => update('description', e.target.value)}
                />
              </Field>
            </div>
            <Field label="Category" htmlFor="category" error={errors.categoryId}>
              <select
                id="category"
                className={inputClass}
                value={form.categoryId}
                onChange={(e) => update('categoryId', e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Initial Yes probability (%)" htmlFor="prob" error={errors.initialYesProbability}>
              <input
                id="prob"
                type="number"
                min={1}
                max={99}
                className={inputClass}
                value={form.initialYesProbability}
                onChange={(e) => update('initialYesProbability', Number(e.target.value))}
              />
            </Field>
            <Field label="Yes outcome label" htmlFor="yesLabel" error={errors.yesLabel}>
              <input
                id="yesLabel"
                className={inputClass}
                value={form.yesLabel}
                onChange={(e) => update('yesLabel', e.target.value)}
              />
            </Field>
            <Field label="No outcome label" htmlFor="noLabel" error={errors.noLabel}>
              <input
                id="noLabel"
                className={inputClass}
                value={form.noLabel}
                onChange={(e) => update('noLabel', e.target.value)}
              />
            </Field>
            <Field label="Opens at" htmlFor="opensAt" error={errors.opensAt}>
              <input
                id="opensAt"
                type="datetime-local"
                className={inputClass}
                value={form.opensAt}
                onChange={(e) => update('opensAt', e.target.value)}
              />
            </Field>
            <Field label="Closes at" htmlFor="closesAt" error={errors.closesAt}>
              <input
                id="closesAt"
                type="datetime-local"
                className={inputClass}
                value={form.closesAt}
                onChange={(e) => update('closesAt', e.target.value)}
              />
            </Field>
            <Field label="Resolves at" htmlFor="resolvesAt" error={errors.resolvesAt}>
              <input
                id="resolvesAt"
                type="datetime-local"
                className={inputClass}
                value={form.resolvesAt}
                onChange={(e) => update('resolvesAt', e.target.value)}
              />
            </Field>
            <Field label="Initial liquidity (₹)" htmlFor="liquidity" error={errors.initialLiquidityRupees}>
              <input
                id="liquidity"
                type="number"
                min={1000}
                className={inputClass}
                value={form.initialLiquidityRupees}
                onChange={(e) => update('initialLiquidityRupees', Number(e.target.value))}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Resolution criteria" htmlFor="criteria" error={errors.resolutionCriteria}>
                <textarea
                  id="criteria"
                  className={`${inputClass} h-16`}
                  value={form.resolutionCriteria}
                  onChange={(e) => update('resolutionCriteria', e.target.value)}
                />
              </Field>
            </div>
            <Field label="Source of truth" htmlFor="source" error={errors.source}>
              <input
                id="source"
                className={inputClass}
                value={form.source}
                onChange={(e) => update('source', e.target.value)}
              />
            </Field>
            <Field label="Status" htmlFor="status">
              <select
                id="status"
                className={inputClass}
                value={form.status}
                onChange={(e) => update('status', e.target.value as 'open' | 'paused')}
              >
                <option value="open">Open</option>
                <option value="paused">Paused</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Button className="h-11 w-full rounded-xl sm:w-auto" onClick={submitMarket}>
                Create market
              </Button>
            </div>
          </Card>
        </section>

        <section>
          <SectionHeading title="Manage markets" icon={<PauseCircle className="size-4" />} />
          <Card className="divide-y divide-border">
            {manageableMarkets.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No markets to manage.</p>
            ) : (
              manageableMarkets.map((market) => (
                <div key={market.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{market.question}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {market.status === 'open' ? <Badge tone="neutral">Open</Badge> : null}
                      {market.status === 'paused' ? <Badge tone="warning">Paused</Badge> : null}
                      {market.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {market.status === 'open' ? (
                      <Button size="sm" variant="outline" onClick={() => handleStatusChange(market, 'paused')}>
                        Pause
                      </Button>
                    ) : null}
                    {market.status === 'paused' ? (
                      <Button size="sm" variant="outline" onClick={() => handleStatusChange(market, 'open')}>
                        Resume
                      </Button>
                    ) : null}
                    {market.status !== 'closed' ? (
                      <Button size="sm" variant="outline" onClick={() => handleStatusChange(market, 'closed')}>
                        Close
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => handleStatusChange(market, 'open')}>
                        Reopen
                      </Button>
                    )}
                    {market.outcomes.map((o) => (
                      <Button
                        key={o.id}
                        size="sm"
                        onClick={() => setPendingResolution({ market, outcomeId: o.id })}
                      >
                        Resolve {o.name}
                      </Button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </Card>
        </section>

        <section>
          <SectionHeading
            title="Refunds"
            icon={<Undo2 className="size-4" />}
            action={
              <input
                className={`${inputClass} h-9 w-44 sm:w-56`}
                placeholder="Search name, phone, ref"
                value={refundQuery}
                onChange={(e) => setRefundQuery(e.target.value)}
              />
            }
          />
          <Card className="divide-y divide-border">
            {adminTransactionsLoading && adminTransactions.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : adminTransactions.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Nothing to refund. Completed deposits and pending withdrawals will show up here.
              </p>
            ) : (
              adminTransactions.map((txn) => (
                <div key={txn.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {txn.userName} <span className="font-normal text-muted-foreground">· {txn.userPhone}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge tone={txn.type === 'deposit' ? 'yes' : 'warning'}>
                        {txn.type === 'deposit' ? 'Deposit · completed' : 'Withdrawal · pending'}
                      </Badge>
                      <span className="tabular-nums">{formatINR(Math.abs(txn.amountPaise))}</span>
                      <span>· {formatDateTime(txn.createdAt)}</span>
                      <span>· {txn.reference}</span>
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setPendingRefund(txn)}>
                    <RotateCcw className="size-3.5" />
                    Refund
                  </Button>
                </div>
              ))
            )}
          </Card>
        </section>

        <PaymentOperations />
      </div>

      <Modal
        open={pendingRefund !== null}
        onClose={() => {
          setPendingRefund(null)
          setRefundReason('')
        }}
        title={pendingRefund?.type === 'withdrawal' ? 'Cancel withdrawal' : 'Reverse deposit'}
        description={pendingRefund ? `${pendingRefund.userName} · ${pendingRefund.userPhone}` : undefined}
        footer={
          <Button className="h-11 w-full rounded-xl" onClick={confirmRefund} disabled={refundBusy} data-autofocus>
            <RotateCcw className="size-4" />
            {refundBusy ? 'Processing…' : 'Confirm refund'}
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {pendingRefund?.type === 'withdrawal' ? (
              <>
                This unlocks{' '}
                <span className="font-semibold text-foreground">{pendingRefund ? formatINR(Math.abs(pendingRefund.amountPaise)) : ''}</span>{' '}
                back to the trader's available balance and cancels the pending payout. This cannot be undone.
              </>
            ) : (
              <>
                This debits{' '}
                <span className="font-semibold text-foreground">{pendingRefund ? formatINR(Math.abs(pendingRefund.amountPaise)) : ''}</span>{' '}
                back out of the trader's available balance. This cannot be undone.
              </>
            )}
          </p>
          <Field label="Reason (optional)" htmlFor="refundReason" hint="Shown to the trader on their transaction history.">
            <input
              id="refundReason"
              className={inputClass}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="e.g. Duplicate deposit"
              maxLength={160}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={pendingResolution !== null}
        onClose={() => setPendingResolution(null)}
        title="Confirm resolution"
        description={pendingResolution?.market.question}
        footer={
          <Button className="h-11 w-full rounded-xl" onClick={confirmResolve} data-autofocus>
            <CheckCircle2 className="size-4" />
            Confirm resolve
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Resolving as{' '}
          <span className="font-semibold text-foreground">
            {pendingResolution?.market.outcomes.find((o) => o.id === pendingResolution.outcomeId)?.name}
          </span>{' '}
          settles every open position on this market, credits winners, and cannot be undone.
        </p>
      </Modal>
    </AppShell>
  )
}
