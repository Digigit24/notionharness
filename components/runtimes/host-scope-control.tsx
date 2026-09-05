'use client'

import { useState } from 'react'
import { Laptop } from 'lucide-react'
import { setRuntimeProfileHost } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { useOptimisticAction } from '@/lib/optimistic'
import { Badge } from '@/components/ui/badge'

/**
 * Shows and edits which machine may claim runs for this profile
 * (`runtime_profiles.host_id` — see `lib/broker/runs.ts`'s `claimNextRun`).
 *
 * Three states, and only two of them offer the same toggle: a profile scoped
 * to THIS machine (the one rendering the page right now) can be unscoped, an
 * unscoped profile can be scoped to this machine, but a profile scoped to a
 * DIFFERENT machine is shown read-only — there is nothing honest for a click
 * from here to do about a machine this server isn't. Fixing that means
 * opening the Runtimes page on the machine actually named, or clearing it
 * from there.
 */
export function HostScopeControl({
  workspaceSlug,
  profileId,
  hostId: initialHostId,
  thisHostId,
  otherHostName,
}: {
  workspaceSlug: string
  profileId: number
  hostId: string | null | undefined
  /** This server's own id (`currentHostId()`), resolved once by the page. */
  thisHostId: string
  /** The `runtime-hosts` display name for `hostId`, when it names a
   * different machine that has one — falls back to the raw id (a hostname)
   * for a profile scoped before that machine was ever named. */
  otherHostName?: string | null
}) {
  const [hostId, setHostId] = useState(initialHostId ?? null)
  const { run, pending } = useOptimisticAction<void>()

  function setScope(scope: 'this-machine' | 'any-machine') {
    const next = scope === 'this-machine' ? thisHostId : null
    const previous = hostId
    void run({
      apply: () => setHostId(next),
      rollback: () => setHostId(previous),
      work: () => setRuntimeProfileHost({ workspaceSlug, profileId, scope }),
      failureTitle: 'Could not change which machine this profile is scoped to',
    })
  }

  if (hostId && hostId !== thisHostId) {
    return (
      <Badge variant="outline" className="gap-1 text-faint" title="Open the Runtimes page on that machine to change this.">
        <Laptop size={11} />
        {otherHostName ?? hostId} only
      </Badge>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setScope(hostId ? 'any-machine' : 'this-machine')}
      disabled={pending}
      title={
        hostId
          ? 'Only this machine may run agents on this profile. Click to allow any machine.'
          : 'Any machine may claim a run for this profile. Click to restrict it to this one.'
      }
      className="flex items-center gap-1 text-[11px] font-medium text-black/50 underline underline-offset-2 hover:text-black disabled:opacity-50 dark:text-white/50 dark:hover:text-white"
    >
      <Laptop size={11} />
      {hostId ? 'This machine only' : 'Any machine'}
    </button>
  )
}
