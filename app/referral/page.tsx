'use client'

import { Check, Copy, Gift, Loader2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { AuthGate } from '@/components/trading/auth-gate'
import { Button } from '@/components/ui/button'
import { Card, inputClass } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'

export default function ReferralPage() {
  const user = useAppStore((s) => s.user)
  const referral = useAppStore((s) => s.referral)
  const claimReferral = useAppStore((s) => s.claimReferral)
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [claiming, setClaiming] = useState(false)

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) setInviteCode(code.toUpperCase())
  }, [])
  const [claimError, setClaimError] = useState('')

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in to get your referral link and rewards." />
      </AppShell>
    )
  }

  const code = referral.code || `PREDIK${user.id.slice(-4).toUpperCase()}`

  async function copy() {
    const invite = `${window.location.origin}/referral?code=${code}`
    await navigator.clipboard?.writeText(invite)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
    toast({ title: 'Invite link copied', description: code, tone: 'success' })
  }

  async function claim() {
    setClaimError('')
    setClaiming(true)
    const result = await claimReferral(inviteCode)
    setClaiming(false)
    if (!result.ok) {
      setClaimError(result.error ?? 'That invite could not be claimed')
      return
    }
    setInviteCode('')
    toast({
      title: 'Welcome bonus credited',
      description: '₹50 was added to your bonus credit. It is a reward and cannot be staked on a trade.',
      tone: 'success',
    })
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <Gift className="size-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Refer &amp; earn</h1>
        </div>
        <Card className="p-5 text-center">
          <p className="text-sm text-muted-foreground">
            Share your code. Both of you get ₹50 of bonus credit — a reward, separate from the balance you trade with.
          </p>
          <div className="mx-auto mt-4 flex max-w-xs items-center justify-between gap-2 rounded-xl border border-dashed border-border px-4 py-3">
            <span className="text-lg font-bold tracking-wide text-foreground">{code}</span>
            <Button size="icon-sm" variant="ghost" onClick={() => void copy()} aria-label="Copy referral link">
              {copied ? <Check className="size-4 text-yes-foreground" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Your invite link is tied to this account and can be shared anywhere.</p>
        </Card>

        <Card className="p-4">
          <p className="text-sm font-semibold text-foreground">Have an invite code?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Claim your ₹50 welcome bonus credit once. It is a reward and is not spendable on trades.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32))}
              placeholder="PREDIK..."
              className={inputClass}
              aria-label="Invite code"
            />
            <Button type="button" onClick={() => void claim()} disabled={claiming || inviteCode.length < 6}>
              {claiming ? <Loader2 className="size-4 animate-spin" /> : 'Claim'}
            </Button>
          </div>
          {claimError ? <p className="mt-2 text-xs font-medium text-no" role="alert">{claimError}</p> : null}
        </Card>

        <div className="grid grid-cols-3 gap-2">
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Invited</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{referral.invitedCount}</p>
          </Card>
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Claimed</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{referral.claimedCount}</p>
          </Card>
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Rewards</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{formatINR(referral.rewardPaise, { whole: true })}</p>
          </Card>
        </div>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <Users className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-semibold text-foreground">Your referrals</p>
              <p className="text-xs text-muted-foreground">Track who has joined with your code.</p>
            </div>
          </div>
          {referral.referrals.length > 0 ? (
            <div className="mt-4 divide-y divide-border rounded-xl border border-border">
              {referral.referrals.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.status === 'claimed' ? 'Joined successfully' : 'Invite sent'}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
                  </div>
                  <p className="text-sm font-semibold text-yes-foreground">{formatINR(item.rewardPaise, { signed: true })}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-xl bg-muted/60 px-3 py-3 text-xs text-muted-foreground">No referrals yet. Share your link to get started.</p>
          )}
        </Card>
      </div>
    </AppShell>
  )
}
