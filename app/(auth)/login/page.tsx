import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { AuthForm } from '@/components/auth/auth-form'
import { safeNextPath } from '@/components/auth/next-path'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const [session, query] = await Promise.all([getSession(), searchParams])
  // Somebody already signed in who follows an invitation link is bounced
  // through here by the invite page only when they are NOT signed in — but they
  // can also arrive with a stale tab, and sending them to the app home would
  // lose the invitation. `safeNextPath` refuses anything that is not a
  // same-origin relative path, so this cannot be turned into an open redirect.
  if (session) redirect(safeNextPath(query.next) ?? '/')

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-8 bg-[#f7f7f5] px-6 py-16 dark:bg-[#191919]">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">NotionForge</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">Log in to your workspace.</p>
      </div>
      {/* `AuthForm` reads `?next=` with `useSearchParams`, which Next requires
          to sit under a Suspense boundary. The fallback is the form's own
          height so the page does not jump when it hydrates. */}
      <Suspense fallback={<div className="h-64 w-full max-w-sm" />}>
        <AuthForm mode="login" />
      </Suspense>
    </div>
  )
}
