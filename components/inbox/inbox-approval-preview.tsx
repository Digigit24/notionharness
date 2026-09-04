'use client'

// R14-P0.9 — the approval kind's detail-pane body.
//
// Reuses `components/thread/PermissionCard` wholesale rather than building a
// second approve/deny UI, per this unit's brief. That card is self-contained
// by design (it is meant to sit inline in a live transcript with no "list" of
// its own to update) and decides by POSTing straight to `/api/approvals` — it
// takes no callback and exposes no hook for "a decision just landed". Two
// consequences follow, both handled here rather than by editing the card:
//
//  1. `y`/`n` (registered in `inbox-workspace.tsx`) call this route's OWN
//     `approveApprovalInbox`/`denyApprovalInbox` — the same optimistic
//     apply-then-reconcile path every other row action uses.
//  2. A mouse click on the card's own buttons resolves the approval just as
//     correctly (same `resolveApproval` underneath, same ownership check) but
//     this pane has no way to know it happened. Rather than poll — D0 forbids
//     an interval for something a push already could cover, and nothing here
//     pushes — this listens for the ONE click that can only mean "a decision
//     is in flight" and asks once, after a delay generous enough for that
//     POST to land, via `getApprovalStatusInbox`. See that action's own
//     comment for why this is a bounded follow-up and not a polling loop.
import { useRef } from 'react'
import { PermissionCard } from '@/components/thread/PermissionCard'
import { isFailureEnvelope } from '@/lib/failures'
import { getApprovalStatusInbox } from '@/app/(app)/workspace/[workspaceSlug]/inbox/actions'
import type { InboxItem } from './inbox-list'

/** Generous rather than tight: a false negative just means the row lingers
 * one extra visit, a false positive would remove a row still legitimately
 * pending. `/api/approvals`' POST is one `resolveApproval` write — this is
 * comfortably past it on anything but a badly stalled connection. */
const FOLLOW_UP_DELAY_MS = 1200

export function InboxApprovalPreview({
  item,
  workspaceSlug,
  onResolvedExternally,
}: {
  item: InboxItem
  workspaceSlug: string
  onResolvedExternally: (id: string) => void
}) {
  const checking = useRef(false)

  function scheduleFollowUpCheck() {
    if (item.approvalId == null || checking.current) return
    checking.current = true
    setTimeout(() => {
      void (async () => {
        try {
          const result = await getApprovalStatusInbox(workspaceSlug, item.approvalId!)
          if (!isFailureEnvelope(result) && result.status !== 'pending') {
            onResolvedExternally(item.id)
          }
        } finally {
          checking.current = false
        }
      })()
    }, FOLLOW_UP_DELAY_MS)
  }

  if (item.approvalId == null || item.externalId == null) {
    return <p className="text-sm text-muted-foreground">This approval is missing the details needed to decide it here.</p>
  }

  return (
    <div onClickCapture={scheduleFollowUpCheck}>
      <PermissionCard
        requestId={item.externalId}
        title={item.headline}
        detail={item.subline ?? ''}
        options={item.approvalOptions ?? []}
      />
    </div>
  )
}
