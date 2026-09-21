import { cn } from '@/lib/utils'

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-[10px] bg-primary text-[15px] leading-none font-black text-primary-foreground"
      >
        P
      </span>
      {showWordmark ? (
        <span className="text-[19px] leading-none font-extrabold tracking-tight text-primary">
          redik
        </span>
      ) : null}
      <span className="sr-only">Predik</span>
    </span>
  )
}
