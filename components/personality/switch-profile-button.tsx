'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { switchActiveHermesProfile } from '@/app/(app)/workspace/[workspaceSlug]/settings/personality/actions'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

// Two-click confirm, matching this codebase's established pattern (e.g.
// components/agents/agent-memories.tsx's delete flow) — switching the
// active Hermes profile is a real, live change to how the assistant
// answers real WhatsApp senders, not a reversible-with-undo UI toggle.
export function SwitchActiveProfileButton({
  workspaceSlug,
  profileName,
  isActive,
}: {
  workspaceSlug: string
  profileName: string
  isActive: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [isPending, startTransition] = useTransition()

  if (isActive) {
    return <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Active</span>
  }

  async function confirmSwitch() {
    setBusy(true)
    try {
      await switchActiveHermesProfile({ workspaceSlug, profileName })
      toast({ title: `Switched active Hermes profile to "${profileName}"` })
      setConfirming(false)
      startTransition(() => router.refresh())
    } catch (error) {
      toast({
        title: 'Could not switch profile',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" variant="destructive" disabled={busy || isPending} onClick={() => void confirmSwitch()}>
          {busy ? 'Switching…' : `Confirm switch to ${profileName}`}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
      Make active
    </Button>
  )
}
