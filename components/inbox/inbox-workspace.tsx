'use client'

// R14-P0.9 — "Inbox: the Activity view, drawn". The container that used to be
// `InboxList` itself: it owns the item list (with its optimistic removals),
// which row is selected, and the keyboard shortcuts — the three pieces of
// state a list and its own preview pane must share rather than duplicate.
//
// THE SPLIT PANE. `InboxList` (left, narrower) never navigates on selection
// any more; `InboxDetailPane` (right) renders whichever item `selectedId`
// names. `router.push` appears exactly once in this whole feature, inside the
// detail pane's own explicit "Open in channel" / "Open task" action — never
// here, and never in the list.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useKeyboardShortcut } from '@/lib/keyboard/use-keyboard-shortcut'
import { useOptimisticAction } from '@/lib/optimistic'
import type { WithFailure } from '@/lib/failures'
import {
  approveApprovalInbox,
  denyApprovalInbox,
  dismissMentionInbox,
  dismissRunInbox,
  markChannelMentionRead,
  retryRunInbox,
} from '@/app/(app)/workspace/[workspaceSlug]/inbox/actions'
import { InboxList, type InboxItem, type RowHandlers } from './inbox-list'
import { InboxDetailPane } from './inbox-detail-pane'

export function InboxWorkspace({ items: initialItems, workspaceSlug }: { items: InboxItem[]; workspaceSlug: string }) {
  const router = useRouter()
  const [items, setItems] = useState(initialItems)
  const [selectedId, setSelectedId] = useState<string | null>(initialItems[0]?.id ?? null)
  const optimistic = useOptimisticAction()

  // Keep the local copy in sync when the server refetches (revalidatePath
  // after an action, or a plain navigation back to this route) — but don't
  // clobber an optimistic removal that's still in flight (`optimistic.run`
  // already applied the local removal synchronously, so by the time a refetch
  // lands the server's list agrees with it anyway).
  useEffect(() => {
    setItems(initialItems)
    setSelectedId((prev) => (prev && initialItems.some((i) => i.id === prev) ? prev : initialItems[0]?.id ?? null))
  }, [initialItems])

  const focused = items.find((i) => i.id === selectedId) ?? null

  function moveFocus(delta: 1 | -1) {
    if (items.length === 0) return
    const ids = items.map((i) => i.id)
    const currentIndex = selectedId != null ? ids.indexOf(selectedId) : -1
    const nextIndex = Math.min(ids.length - 1, Math.max(0, currentIndex === -1 ? 0 : currentIndex + delta))
    setSelectedId(ids[nextIndex])
  }

  /**
   * D0's optimistic pattern (`lib/optimistic.ts`), generalised over the six
   * actions a row (or the detail pane showing the same item) can take: paint
   * the removal now, run the server call, put the row back with a toast if it
   * refuses. Every one of them removes its item on success — even a retry,
   * which replaces the failed run with a fresh one elsewhere — so one function
   * covers all six rather than each call site re-deriving the same three
   * lines.
   */
  function runAction<T>(id: string, work: () => Promise<WithFailure<T>>, failureTitle: string) {
    const prevItems = items
    const prevSelected = selectedId
    const idx = items.findIndex((i) => i.id === id)
    const nextItems = items.filter((i) => i.id !== id)
    const nextSelected = prevSelected === id ? (nextItems[Math.min(idx, nextItems.length - 1)]?.id ?? null) : prevSelected
    void optimistic.run({
      apply: () => {
        setItems(nextItems)
        setSelectedId(nextSelected)
      },
      rollback: () => {
        setItems(prevItems)
        setSelectedId(prevSelected)
      },
      work,
      failureTitle,
    })
  }

  /**
   * The one path that does NOT go through `runAction`'s optimistic apply: the
   * approval preview's bounded follow-up check (see `inbox-approval-preview.tsx`
   * and `getApprovalStatusInbox`'s own comment) already knows the decision has
   * landed on the SERVER by the time it calls this — there is nothing left to
   * apply-then-reconcile, just the same removal every other resolved action
   * ends with.
   */
  function removeResolvedItem(id: string) {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id)
      if (idx === -1) return prev
      const next = prev.filter((i) => i.id !== id)
      setSelectedId((current) => (current === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : current))
      return next
    })
  }

  function handlersFor(item: InboxItem): RowHandlers {
    return {
      onApprove: (optionId) =>
        runAction(item.id, () => approveApprovalInbox(workspaceSlug, item.approvalId!, optionId), 'Could not approve'),
      onDeny: () => runAction(item.id, () => denyApprovalInbox(workspaceSlug, item.approvalId!), 'Could not deny'),
      onRetry: () => runAction(item.id, () => retryRunInbox(workspaceSlug, item.runId!), 'Could not retry'),
      onDismissRun: () => runAction(item.id, () => dismissRunInbox(workspaceSlug, item.runId!), 'Could not dismiss'),
      onDismissMention: () =>
        runAction(item.id, () => dismissMentionInbox(workspaceSlug, item.notificationId!), 'Could not dismiss'),
      onMarkChannelRead: () =>
        runAction(item.id, () => markChannelMentionRead(workspaceSlug, item.channelMessageId!), 'Could not mark read'),
    }
  }

  /** The detail pane's one and only navigation: an explicit "open this in its
   * full context" action, never a side effect of selecting the row. Mirrors
   * what the old `<Link onClick={...}>` did before opening — the same
   * read/dismiss side effect — but now as something the reader chooses. */
  function openInFullContext(item: InboxItem) {
    if (!item.href) return
    if (item.kind === 'review_run') handlersFor(item).onDismissRun()
    else if (item.kind === 'mention') handlersFor(item).onDismissMention()
    else if (item.kind === 'channel_mention') handlersFor(item).onMarkChannelRead()
    router.push(item.href)
  }

  useKeyboardShortcut('j', 'Next item', () => moveFocus(1), 'list')
  useKeyboardShortcut('k', 'Previous item', () => moveFocus(-1), 'list')
  useKeyboardShortcut(
    'enter',
    'Open focused item',
    () => {
      if (!focused) return
      // Enter reads/dismisses in place, exactly as it did before this unit's
      // change — the only thing removed is the navigation that used to follow
      // it. Selecting the row already shows it in the right pane; Enter's own
      // job is now just "I've seen this."
      if (focused.kind === 'mention' && focused.notificationId != null) handlersFor(focused).onDismissMention()
      else if (focused.kind === 'channel_mention' && focused.channelMessageId != null) handlersFor(focused).onMarkChannelRead()
      else if (focused.kind === 'review_run' && focused.runId != null) handlersFor(focused).onDismissRun()
    },
    'list',
  )
  useKeyboardShortcut(
    'y',
    'Approve focused approval',
    () => {
      if (focused?.kind === 'approval' && focused.approvalId != null) {
        const optionId = focused.approvalOptions?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')?.optionId
        handlersFor(focused).onApprove(optionId)
      }
    },
    'list',
  )
  useKeyboardShortcut(
    'n',
    'Deny focused approval',
    () => {
      if (focused?.kind === 'approval' && focused.approvalId != null) handlersFor(focused).onDeny()
    },
    'list',
  )
  useKeyboardShortcut(
    'r',
    'Retry focused failed run',
    () => {
      if (focused?.kind === 'failed_run' && focused.canRetry && focused.runId != null) handlersFor(focused).onRetry()
    },
    'list',
  )
  useKeyboardShortcut(
    'e',
    'Dismiss focused item',
    () => {
      if (!focused) return
      if ((focused.kind === 'failed_run' || focused.kind === 'review_run') && focused.runId != null) {
        handlersFor(focused).onDismissRun()
      } else if (focused.kind === 'mention' && focused.notificationId != null) {
        handlersFor(focused).onDismissMention()
      } else if (focused.kind === 'channel_mention' && focused.channelMessageId != null) {
        handlersFor(focused).onMarkChannelRead()
      }
    },
    'list',
  )

  if (items.length === 0) {
    return <InboxList items={[]} selectedId={null} onSelect={() => undefined} handlersFor={handlersFor} />
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="flex w-full max-w-sm shrink-0 flex-col overflow-y-auto pr-1">
        <InboxList items={items} selectedId={selectedId} onSelect={setSelectedId} handlersFor={handlersFor} />
      </div>
      {/* `overflow-hidden`, not `-y-auto`: `InboxDetailPane` (and each of its
          per-kind bodies) already manages its own scroll region under a
          `shrink-0` header, so this only needs to CLIP to the row's height,
          not add a second scrollbar around the pane's own. */}
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
        <InboxDetailPane
          item={focused}
          workspaceSlug={workspaceSlug}
          handlers={focused ? handlersFor(focused) : null}
          onOpen={() => focused && openInFullContext(focused)}
          onResolvedExternally={removeResolvedItem}
        />
      </div>
    </div>
  )
}
