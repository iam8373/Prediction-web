import { cn } from '@/lib/utils'

export function Card({
  className,
  as: Tag = 'div',
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' }) {
  return (
    <Tag
      className={cn(
        'rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
        className,
      )}
      {...props}
    />
  )
}

export function SectionHeading({
  title,
  action,
  icon,
}: {
  title: string
  action?: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  )
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'yes' | 'no' | 'live' | 'brand' | 'warning'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-semibold',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        tone === 'yes' && 'bg-yes-soft text-yes-foreground',
        tone === 'no' && 'bg-no-soft text-no-foreground',
        tone === 'live' && 'bg-live text-white',
        tone === 'brand' && 'bg-accent text-accent-foreground',
        tone === 'warning' && 'bg-warning/15 text-warning',
        className,
      )}
      {...props}
    />
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-muted', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export const inputClass =
  'h-11 w-full rounded-xl border border-border bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/70 transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none disabled:opacity-60'

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-no" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function StatTile({
  label,
  value,
  tone = 'default',
  sub,
}: {
  label: string
  value: string
  tone?: 'default' | 'yes' | 'no'
  sub?: string
}) {
  return (
    <div className="rounded-xl bg-muted/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-base font-semibold tabular-nums',
          tone === 'yes' && 'text-yes-foreground',
          tone === 'no' && 'text-no-foreground',
        )}
      >
        {value}
      </p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  )
}
