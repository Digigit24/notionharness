'use client'

import { useState, useTransition } from 'react'
import { createWorkspace } from '@/app/(app)/actions'

export function CreateWorkspaceForm() {
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        startTransition(() => {
          void createWorkspace(trimmed)
        })
      }}
      className="flex w-full max-w-sm gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New workspace name"
        className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none dark:border-white/10 dark:bg-[#202020]"
      />
      <button
        type="submit"
        disabled={isPending}
        className="shrink-0 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-black/80 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-white/80"
      >
        {isPending ? 'Creating...' : 'Create workspace'}
      </button>
    </form>
  )
}
