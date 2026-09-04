import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { StaleBuildNotice } from '@/components/app/stale-build-notice'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <>
      {children}
      {/* Watches for the "tab left open across a deploy" failure, which
          otherwise breaks every Server Action on the page with no
          explanation. See the component for why this is a listener and not
          an error boundary. */}
      <StaleBuildNotice />
    </>
  )
}
