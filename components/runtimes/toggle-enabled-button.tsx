'use client'

import { toggleRuntimeProfileEnabled } from '@/app/(app)/workspace/[workspaceSlug]/settings/runtimes/actions'
import { useOptimisticAction } from '@/lib/optimistic'
import { Badge } from '@/components/ui/badge'
import { useState } from 'react'

/**
 * The "Disabled" badge and its toggle, together.
 *
 * Both used to be split across a server-rendered `Badge` in the page and this
 * client button reading its own `enabled` prop — so a click flipped the
 * button's own label immediately but left the badge showing the STALE state
 * until `router.refresh()` finished a full server round trip. D0 forbids
 * that gap, and the fix is for one client component to own both: `enabled`
 * lives here as local state, seeded once from the server prop, and both the
 * badge and the label read the same value.
 */
export function ToggleRuntimeProfileEnabledButton({
  workspaceSlug,
  profileId,
  enabled: initialEnabled,
}: {
  workspaceSlug: string
  profileId: number
  enabled: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const { run, pending } = useOptimisticAction<void>()

  function toggle() {
    const next = !enabled
    void run({
      apply: () => setEnabled(next),
      rollback: () => setEnabled(!next),
      work: () => toggleRuntimeProfileEnabled({ workspaceSlug, profileId, enabled: next }),
      failureTitle: 'Could not update runtime profile',
    })
  }

  return (
    <>
      {!enabled && (
        <Badge variant="outline" className="text-faint">
          Disabled
        </Badge>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="text-[11px] font-medium text-black/50 underline underline-offset-2 hover:text-black disabled:opacity-50 dark:text-white/50 dark:hover:text-white"
      >
        {enabled ? 'Disable' : 'Enable'}
      </button>
    </>
  )
}
