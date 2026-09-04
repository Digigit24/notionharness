import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { AuthForm } from '@/components/auth/auth-form'
import { safeNextPath } from '@/components/auth/next-path'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const [session, query] = await Promise.all([getSession(), searchParams])
  // The invitation path: somebody with no account arrives at /invite/<token>,
  // is sent here with that path as `next`, and lands back on the invitation
  // instead of on an empty app home wondering what they were sent.
  // `safeNextPath` refuses anything that is not a same-origin relative path —
  // this is the page an unauthenticated stranger is deliberately sent links to,
  // so an unvalidated `next` here would be an open redirect wearing this app's
  // domain.
  if (session) redirect(safeNextPath(query.next) ?? '/')

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-8 bg-[#f7f7f5] px-6 py-16 dark:bg-[#191919]">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">NotionForge</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">Create your account.</p>
      </div>
      <Suspense fallback={<div className="h-72 w-full max-w-sm" />}>
        <AuthForm mode="signup" />
      </Suspense>
    </div>
  )
}
