import { LogIn } from 'lucide-react'
import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/primitives'

export function AuthGate({ message }: { message: string }) {
  return (
    <EmptyState
      icon={<LogIn className="size-8" />}
      title="Sign in required"
      description={message}
      action={
        <Link href="/login" className={buttonVariants({ size: 'lg' })}>
          Sign in
        </Link>
      }
    />
  )
}
