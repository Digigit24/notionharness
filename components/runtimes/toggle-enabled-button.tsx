'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toggleRuntimeProfileEnabled } from '@/app/(app)/workspace/[workspaceSlug]/runtimes/actions'
import { toast } from '@/hooks/use-toast'

export function ToggleRuntimeProfileEnabledButton({
  workspaceSlug,
  profileId,
  enabled,
}: {
  workspaceSlug: string
  profileId: number
  enabled: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function toggle() {
    setBusy(true)
    try {
      await toggleRuntimeProfileEnabled({ workspaceSlug, profileId, enabled: !enabled })
      startTransition(() => router.refresh())
    } catch (error) {
      toast({
        title: 'Could not update runtime profile',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy || isPending}
      className="text-[11px] font-medium text-black/50 underline underline-offset-2 hover:text-black disabled:opacity-50 dark:text-white/50 dark:hover:text-white"
    >
      {enabled ? 'Disable' : 'Enable'}
    </button>
  )
}
