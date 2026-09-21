import { BottomNav } from '@/components/layout/bottom-nav'
import { Sidebar } from '@/components/layout/sidebar'
import { TopBar } from '@/components/layout/top-bar'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pt-4 pb-24 lg:px-6 lg:pb-10">
          {children}
        </main>
        <BottomNav />
      </div>
    </div>
  )
}
