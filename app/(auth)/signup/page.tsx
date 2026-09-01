import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { AuthForm } from '@/components/auth/auth-form'

export default async function SignupPage() {
  const session = await getSession()
  if (session) redirect('/')

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-8 bg-[#f7f7f5] px-6 py-16 dark:bg-[#191919]">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">NotionForge</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/50">Create your account.</p>
      </div>
      <AuthForm mode="signup" />
    </div>
  )
}
