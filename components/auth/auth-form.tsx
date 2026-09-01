'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth-client'

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter()
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
    router.push('/')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-3">
      {mode === 'signup' && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoComplete="name"
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-white/10 dark:bg-[#202020]"
        />
      )}
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        required
        placeholder="Email"
        autoComplete="email"
        className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-white/10 dark:bg-[#202020]"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        required
        minLength={8}
        placeholder="Password"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-white/10 dark:bg-[#202020]"
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
            <Link href="/login" className="underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="underline">
              Sign up
            </Link>
          </>
        )}
      </p>
    </form>
  )
}
