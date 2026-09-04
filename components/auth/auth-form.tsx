'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth-client'
import { safeNextPath } from './next-path'

/**
 * `?next=` exists for exactly one reason: an invitation link.
 *
 * Somebody who has been invited arrives at `/invite/<token>` with no account.
 * Sending them to sign up and then landing them on the app home would strand
 * them one step short of the thing they came for, with the token only in their
 * browser history. So both pages carry the destination through and come back to
 * it. `router.push('/')` remains the default when there is no `next`, so every
 * other path into these forms is unchanged.
 *
 * The validation in `safeNextPath` is not optional: an unvalidated `next` on a
 * SIGNUP page is an open redirect on the one page an unauthenticated stranger
 * is meant to reach, which is how a phishing link gets to borrow this app's
 * domain. Same-origin relative paths only.
 */
export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = safeNextPath(searchParams.get('next'))
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)

    const result =
      mode === 'signup'
        ? await authClient.signUp.email({ name: name.trim() || email.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password })

    setIsPending(false)
    if (result.error) {
      setError(result.error.message || 'Something went wrong.')
      return
    }
    router.push(next ?? '/')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-3">
      {mode === 'signup' && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          aria-label="Name"
          autoComplete="name"
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10 dark:bg-[#202020]"
        />
      )}
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        required
        placeholder="Email"
        aria-label="Email"
        autoComplete="email"
        className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10 dark:bg-[#202020]"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        required
        minLength={8}
        placeholder="Password"
        aria-label="Password"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-white/10 dark:bg-[#202020]"
      />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/80 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-white/80"
      >
        {isPending ? 'Please wait...' : mode === 'signup' ? 'Sign up' : 'Log in'}
      </button>

      <p className="text-center text-sm text-black/50 dark:text-white/50">
        {mode === 'signup' ? (
          <>
            Already have an account?{' '}
            <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} className="underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            Don&apos;t have an account?{' '}
            <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'} className="underline">
              Sign up
            </Link>
          </>
        )}
      </p>
    </form>
  )
}
