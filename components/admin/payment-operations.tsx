'use client'

import { AlertTriangle, CheckCircle2, PlayCircle, RefreshCw, ShieldCheck, Undo2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Badge, Card, Field, inputClass, SectionHeading, StatTile } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { formatDateTime } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'
import type { PaymentRecord } from '@/types'

/**
 * Admin payment operations: inspect every payment request (provider reference,
 * status, refund status, reconciliation status), resolve withdrawals that have
 * not settled, re-drive stuck payments, run reconciliation and inspect webhook
 * deliveries. Payments here are all provider-independent — no secrets shown.
 */

const DIRECTION_LABEL: Record<PaymentRecord['direction'], string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
}

function statusTone(status: PaymentRecord['status']): 'neutral' | 'yes' | 'no' | 'warning' | 'brand' {
  switch (status) {
    case 'completed':
      return 'yes'
    case 'refunded':
    case 'partially_refunded':
      return 'brand'
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'no'
    default:
      return 'warning'
  }
}

function reconciliationTone(status: PaymentRecord['reconciliationStatus']): 'neutral' | 'yes' | 'warning' {
  if (status === 'matched') return 'yes'
  if (status === 'unchecked') return 'neutral'
  return 'warning'
}

export function PaymentOperations() {
  const adminPayments = useAppStore((s) => s.adminPayments)
  const adminWebhookEvents = useAppStore((s) => s.adminWebhookEvents)
  const adminRuns = useAppStore((s) => s.adminReconciliationRuns)
  const adminFindings = useAppStore((s) => s.adminReconciliationFindings)
  const adminAuditTrail = useAppStore((s) => s.adminAuditTrail)
  const awaitingProvider = useAppStore((s) => s.adminAwaitingProvider)
  const loading = useAppStore((s) => s.adminPaymentsLoading)
  const summary = useAppStore((s) => s.paymentsSummary)
  const adminFetchPayments = useAppStore((s) => s.adminFetchPayments)
  const adminRunReconciliation = useAppStore((s) => s.adminRunReconciliation)
  const adminRecheckPayments = useAppStore((s) => s.adminRecheckPayments)
  const adminRunRetention = useAppStore((s) => s.adminRunRetention)
  const adminAuditWallet = useAppStore((s) => s.adminAuditWallet)
  const adminResolveWithdrawal = useAppStore((s) => s.adminResolveWithdrawal)
  const adminSimulateSandboxPayment = useAppStore((s) => s.adminSimulateSandboxPayment)
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [auditUserId, setAuditUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ payment: PaymentRecord; action: 'complete' | 'fail' | 'cancel' } | null>(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => adminFetchPayments(query), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const needsReview = adminPayments.filter(
    (payment) => payment.reconciliationStatus !== 'unchecked' && payment.reconciliationStatus !== 'matched',
  ).length
  const pendingWithdrawals = adminPayments.filter(
    (payment) => payment.direction === 'withdrawal' && !['completed', 'failed', 'cancelled', 'expired'].includes(payment.status),
  ).length
  const settledVolume = adminPayments
    .filter((payment) => payment.status === 'completed' && payment.direction !== 'refund')
    .reduce((sum, payment) => sum + payment.amountPaise, 0)

  async function confirmAction() {
    if (!pendingAction) return
    setBusy(true)
    const result = await adminResolveWithdrawal(pendingAction.payment.id, pendingAction.action, reason.trim() || undefined)
    setBusy(false)
    setPendingAction(null)
    setReason('')
    if (result.ok) {
      toast({ title: 'Withdrawal updated', description: `Now ${result.paymentStatus}`, tone: 'success' })
    } else {
      toast({ title: 'Action failed', description: result.error, tone: 'error' })
    }
  }

  async function runReconciliation() {
    setBusy(true)
    const result = await adminRunReconciliation()
    setBusy(false)
    toast(
      result.ok
        ? { title: 'Reconciliation complete', description: result.paymentStatus, tone: 'success' }
        : { title: 'Reconciliation failed', description: result.error, tone: 'error' },
    )
  }

  async function auditWallet() {
    if (!auditUserId.trim()) return
    setBusy(true)
    const result = await adminAuditWallet(auditUserId.trim())
    setBusy(false)
    toast(
      result.ok
        ? { title: 'Wallet / ledger audit', description: result.paymentStatus, tone: 'success' }
        : { title: 'Wallet audit failed', description: result.error, tone: 'error' },
    )
  }

  async function recheck() {
    setBusy(true)
    const result = await adminRecheckPayments()
    setBusy(false)
    toast(
      result.ok
        ? { title: 'Re-checked pending payments', description: result.paymentStatus, tone: 'success' }
        : { title: 'Re-check failed', description: result.error, tone: 'error' },
    )
  }

  async function retention(dryRun: boolean) {
    setBusy(true)
    const result = await adminRunRetention(dryRun)
    setBusy(false)
    toast(
      result.ok
        ? { title: dryRun ? 'Retention dry run' : 'Retention purge complete', description: result.paymentStatus, tone: 'success' }
        : { title: 'Retention run failed', description: result.error, tone: 'error' },
    )
  }

  async function simulate(payment: PaymentRecord, outcome: 'succeeded' | 'failed') {
    setBusy(true)
    const result = await adminSimulateSandboxPayment(payment.id, outcome)
    setBusy(false)
    toast(
      result.ok
        ? { title: `Sandbox provider reported ${outcome}`, description: payment.id, tone: 'success' }
        : { title: 'Simulation failed', description: result.error, tone: 'error' },
    )
  }

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Payments"
          icon={<ShieldCheck className="size-4" />}
          action={
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} h-9 w-40 sm:w-56`}
                placeholder="Search name, phone, ref"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button size="sm" variant="outline" onClick={() => adminFetchPayments(query)} disabled={loading}>
                <RefreshCw className="size-3.5" />
                Refresh
              </Button>
            </div>
          }
        />

        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Payment mode" value={(summary?.mode ?? 'demo').toUpperCase()} sub={summary?.providerLabel} />
          <StatTile label="Settled payments" value={formatINR(settledVolume)} />
          <StatTile label="Withdrawals in flight" value={`${pendingWithdrawals}`} />
          <StatTile label="Needs reconciliation" value={`${needsReview}`} tone={needsReview > 0 ? 'no' : 'default'} />
          <StatTile
            label="Awaiting provider"
            value={`${awaitingProvider}`}
            sub="re-check runs automatically"
          />
        </div>

        {summary && !summary.liveEnabled ? (
          <Card className="mb-3 p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <AlertTriangle className="size-4 text-warning" />
              Live money is disabled. Unmet prerequisites:
            </p>
            <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              {summary.blockers.length === 0 ? (
                <li>No blockers reported.</li>
              ) : (
                summary.blockers.map((blocker) => <li key={blocker}>· {blocker}</li>)
              )}
            </ul>
          </Card>
        ) : null}

        <Card className="divide-y divide-border">
          {loading && adminPayments.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : adminPayments.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No payments recorded yet.</p>
          ) : (
            adminPayments.map((payment) => {
              const final = ['completed', 'failed', 'cancelled', 'expired'].includes(payment.status)
              return (
                <div key={payment.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {payment.userName ?? payment.userId}
                      <span className="font-normal text-muted-foreground"> · {payment.userPhone || '—'}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge tone={statusTone(payment.status)}>{DIRECTION_LABEL[payment.direction]} · {payment.status}</Badge>
                      <Badge tone="neutral">{payment.provider}</Badge>
                      <Badge tone={reconciliationTone(payment.reconciliationStatus)}>{payment.reconciliationStatus}</Badge>
                      {payment.accountStatus && payment.accountStatus !== 'active' ? (
                        <Badge tone="no">account {payment.accountStatus}</Badge>
                      ) : null}
                      {payment.kycStatus && payment.kycStatus !== 'verified' ? (
                        <Badge tone="warning">kyc {payment.kycStatus}</Badge>
                      ) : null}
                      {payment.liveEligible ? <Badge tone="brand">live-eligible</Badge> : null}
                      {payment.refundStatus !== 'none' ? <Badge tone="brand">refund {payment.refundStatus}</Badge> : null}
                      <span className="tabular-nums">{formatINR(payment.amountPaise)}</span>
                    </div>
                    <p className="mt-1 break-all text-[11px] text-muted-foreground">
                      {payment.id} · provider {payment.providerPaymentId ?? '—'} · ref {payment.providerReference ?? '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      created {formatDateTime(payment.createdAt)} · updated {formatDateTime(payment.updatedAt)}
                      {payment.destination ? ` · to ${payment.destination}` : ''}
                    </p>
                    {payment.failureReason ? <p className="mt-1 text-[11px] text-no">{payment.failureReason}</p> : null}
                    {payment.recheckAttempts > 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        provider re-checks: {payment.recheckAttempts}
                        {payment.lastRecheckedAt ? ` · last ${formatDateTime(payment.lastRecheckedAt)}` : ''}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    {payment.direction === 'withdrawal' && !final ? (
                      <>
                        <Button size="sm" onClick={() => setPendingAction({ payment, action: 'complete' })}>
                          <CheckCircle2 className="size-3.5" />
                          Complete
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPendingAction({ payment, action: 'fail' })}>
                          <XCircle className="size-3.5" />
                          Fail
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPendingAction({ payment, action: 'cancel' })}>
                          <Undo2 className="size-3.5" />
                          Cancel
                        </Button>
                      </>
                    ) : null}
                    {payment.provider === 'sandbox' && !final ? (
                      <>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => simulate(payment, 'succeeded')}>
                          <PlayCircle className="size-3.5" />
                          Simulate success
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => simulate(payment, 'failed')}>
                          Simulate failure
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Reconciliation"
          icon={<RefreshCw className="size-4" />}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={recheck} disabled={busy}>
                <RefreshCw className="size-3.5" />
                Re-check pending
              </Button>
              <Button size="sm" variant="outline" onClick={runReconciliation} disabled={busy}>
                Run reconciliation
              </Button>
            </div>
          }
        />
        <Card className="divide-y divide-border">
          {adminRuns.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No reconciliation runs yet.</p>
          ) : (
            adminRuns.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center gap-2 p-4 text-xs text-muted-foreground">
                <Badge tone={run.mismatchCount > 0 ? 'warning' : 'yes'}>{run.status}</Badge>
                <span>{run.provider}</span>
                <span>{run.matchedCount}/{run.checkedCount} matched</span>
                <span>· {run.mismatchCount} to review</span>
                <span>· {formatDateTime(run.finishedAt ?? run.startedAt)}</span>
              </div>
            ))
          )}
          {adminFindings.length > 0 ? (
            <div className="p-4">
              <p className="mb-2 text-xs font-semibold text-foreground">Findings needing review</p>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {adminFindings.map((finding) => (
                  <li key={finding.id}>
                    · <span className="font-medium text-foreground">{finding.status.replace(/_/g, ' ')}</span> — {finding.paymentIntentId}
                    {finding.notes ? ` — ${finding.notes}` : ''}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Mismatches are recorded for controlled handling and are never corrected automatically.
              </p>
            </div>
          ) : null}
        </Card>
      </section>

      <section>
        <SectionHeading title="Webhook deliveries" icon={<ShieldCheck className="size-4" />} />
        <Card className="divide-y divide-border">
          {adminWebhookEvents.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No provider webhooks received yet.</p>
          ) : (
            adminWebhookEvents.map((event) => (
              <div key={event.id} className="flex flex-wrap items-center gap-2 p-4 text-xs text-muted-foreground">
                <Badge
                  tone={event.status === 'processed'
                    ? 'yes'
                    : event.status === 'failed' || event.status === 'rejected'
                      ? 'no'
                      : 'neutral'}
                >
                  {event.status}
                </Badge>
                <span>{event.provider}</span>
                <span>{event.eventType}</span>
                <span>· attempts {event.attempts}</span>
                <span>· {formatDateTime(event.receivedAt)}</span>
                {event.error ? <span className="text-no">· {event.error}</span> : null}
              </div>
            ))
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Payment audit trail"
          icon={<ShieldCheck className="size-4" />}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} h-9 w-40 lg:w-52`}
                placeholder="User id to audit"
                value={auditUserId}
                onChange={(event) => setAuditUserId(event.target.value)}
              />
              <Button size="sm" variant="outline" onClick={auditWallet} disabled={busy || auditUserId.trim().length === 0}>
                Audit wallet
              </Button>
              <Button size="sm" variant="outline" onClick={() => retention(true)} disabled={busy}>
                Retention dry run
              </Button>
              <Button size="sm" variant="outline" onClick={() => retention(false)} disabled={busy}>
                Purge expired
              </Button>
            </div>
          }
        />
        <Card className="divide-y divide-border">
          {adminAuditTrail.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No audited payment actions yet.</p>
          ) : (
            adminAuditTrail.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-2 p-4 text-xs text-muted-foreground">
                <Badge tone={entry.actorRole === 'admin' ? 'brand' : 'neutral'}>{entry.actorRole}</Badge>
                <span className="font-medium text-foreground">{entry.action}</span>
                <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
                <span>· {formatDateTime(entry.createdAt)}</span>
              </div>
            ))
          )}
        </Card>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Retention only removes operational records (handled webhook deliveries and reviewed reconciliation history).
          Payment, transaction and ledger rows are the accounting trail and are never deleted.
        </p>
      </section>

      <Modal
        open={pendingAction !== null}
        onClose={() => {
          setPendingAction(null)
          setReason('')
        }}
        title={
          pendingAction?.action === 'complete'
            ? 'Complete withdrawal'
            : pendingAction?.action === 'cancel'
              ? 'Cancel withdrawal'
              : 'Mark withdrawal failed'
        }
        description={pendingAction ? `${pendingAction.payment.userName ?? pendingAction.payment.userId} · ${formatINR(pendingAction.payment.amountPaise)}` : undefined}
        footer={
          <Button className="h-11 w-full rounded-xl" onClick={confirmAction} disabled={busy} data-autofocus>
            {busy ? 'Processing…' : 'Confirm'}
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {pendingAction?.action === 'complete'
              ? 'This finalises the payout: the reserved amount is debited from the trader’s locked balance.'
              : 'This releases the reserved funds back to the trader’s available balance.'}
          </p>
          <Field label="Reason (optional)" htmlFor="paymentActionReason" hint="Recorded in the audit log.">
            <input
              id="paymentActionReason"
              className={inputClass}
              value={reason}
              maxLength={160}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Payout returned by bank"
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
