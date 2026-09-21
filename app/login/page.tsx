'use client'

import { Loader2, ShieldCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Logo } from '@/components/layout/logo'
import { Button } from '@/components/ui/button'
import { inputClass } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { useAppStore } from '@/lib/store/use-app-store'
import { otpSchema, phoneSchema } from '@/lib/validation/schemas'

export default function LoginPage() {
  const router = useRouter()
  const { toast } = useToast()
  const requestOtp = useAppStore((s) => s.requestOtp)
  const signIn = useAppStore((s) => s.signIn)

  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [demoCode, setDemoCode] = useState('')

  async function handleSendOtp() {
    const parsed = phoneSchema.safeParse(phone)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid number')
      return
    }
    setError('')
    setSubmitting(true)
    const code = await requestOtp(phone)
    setSubmitting(false)
    setDemoCode(code)
    setStep('otp')
    toast({ title: 'Code sent', description: `Demo OTP: ${code}`, tone: 'info' })
  }

  async function handleVerify() {
    const parsed = otpSchema.safeParse(otp)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the 6 digit code')
      return
    }
    setError('')
    setSubmitting(true)
    const result = await signIn(phone, otp)
    setSubmitting(false)
    if (result.ok) {
      toast({ title: 'Welcome back', tone: 'success' })
      router.push('/')
    } else {
      setError(result.error ?? 'Something went wrong')
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo />
          <p className="text-sm text-muted-foreground">Trade your predictions. Demo build — no real money.</p>
        </div>

        {step === 'phone' ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="phone" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Mobile number
              </label>
              <div className="relative">
                <span className="absolute top-1/2 left-3.5 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                  +91
                </span>
                <input
                  id="phone"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="98765 43210"
                  className={`${inputClass} pl-12`}
                  data-autofocus
                />
              </div>
              {error ? <p className="mt-1.5 text-xs font-medium text-no">{error}</p> : null}
            </div>
            <Button className="h-11 w-full rounded-xl" disabled={submitting} onClick={handleSendOtp}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Send OTP
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Try demo number 9876543210 to explore a pre-loaded account.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-accent-foreground">
              <ShieldCheck className="size-4" /> Demo code: {demoCode}
            </div>
            <div>
              <label htmlFor="otp" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                6 digit code sent to +91 {phone}
              </label>
              <input
                id="otp"
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                className={`${inputClass} text-center text-lg font-semibold tracking-[0.4em]`}
                data-autofocus
              />
              {error ? <p className="mt-1.5 text-xs font-medium text-no">{error}</p> : null}
            </div>
            <Button className="h-11 w-full rounded-xl" disabled={submitting} onClick={handleVerify}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Verify &amp; sign in
            </Button>
            <button
              type="button"
              onClick={() => setStep('phone')}
              className="w-full text-center text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Change number
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
