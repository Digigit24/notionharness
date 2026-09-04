'use client'

// ROADMAP B5.2 (Batch B-5 "Attention") — the Inbox's real list surface: one
// chronological, keyboard-navigable, dismissible stream. Reuses the exact
// `j`/`k`-under-the-'list'-scope pattern components/tasks/task-list-view.tsx
// established in Batch B-4 (lib/keyboard/registry.ts's `'list'` scope,
// ref-counted activate/deactivate) rather than inventing a second keyboard-
// nav implementation — this repo's own convention, per this batch's brief.
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, AtSign, Check, FileDiff, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { useKeyboardShortcut } from '@/lib/keyboard/use-keyboard-shortcut'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  approveApprovalInbox,
  denyApprovalInbox,
  dismissMentionInbox,
  dismissRunInbox,
  retryRunInbox,
} from '@/app/(app)/workspace/[workspaceSlug]/inbox/actions'
import type { ApprovalOption } from '@/collections/Approvals'
import { formatTimestamp } from '@/lib/relative-time'

export type InboxItemKind = 'approval' | 'failed_run' | 'review_run' | 'mention'

export interface InboxItem {
  id: string
  kind: InboxItemKind
  headline: string
  subline: string | null
  time: string
  href: string | null
  approvalId?: number
  approvalOptions?: ApprovalOption[]
  runId?: number
  canRetry?: boolean
  notificationId?: number
}

const KIND_META: Record<InboxItemKind, { label: string; icon: typeof ShieldAlert }> = {
  approval: { label: 'Approval', icon: ShieldAlert },
  failed_run: { label: 'Failed run', icon: AlertTriangle },
  review_run: { label: 'Review-ready', icon: FileDiff },
  mention: { label: 'Mention', icon: AtSign },
}

export function InboxList({ items: initialItems, workspaceSlug }: { items: InboxItem[]; workspaceSlug: string }) {
  const [items, setItems] = useState(initialItems)
  const [focusedId, setFocusedId] = useState<string | null>(initialItems[0]?.id ?? null)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const router = useRouter()

  // Keep the local copy in sync when the server refetches (revalidatePath
  // after an action, or a plain navigation back to this route) — but don't
  // clobber an optimistic removal that's still in flight.
  useEffect(() => {
    setItems(initialItems)
    setFocusedId((prev) => (prev && initialItems.some((i) => i.id === prev) ? prev : initialItems[0]?.id ?? null))
  }, [initialItems])

  const ids = useMemo(() => items.map((i) => i.id), [items])

  function moveFocus(delta: 1 | -1) {
    if (ids.length === 0) return
    const currentIndex = focusedId != null ? ids.indexOf(focusedId) : -1
    const nextIndex = Math.min(ids.length - 1, Math.max(0, currentIndex === -1 ? 0 : currentIndex + delta))
    setFocusedId(ids[nextIndex])
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== id)
      setFocusedId((current) => {
        if (current !== id) return current
        const removedIndex = prev.findIndex((i) => i.id === id)
        return next[Math.min(removedIndex, next.length - 1)]?.id ?? null
      })
      return next
    })
  }

  async function runAction(id: string, fn: () => Promise<unknown>) {
    setPendingIds((prev) => new Set(prev).add(id))
    setErrorMessage(null)
    try {
      await fn()
      removeItem(id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const focused = items.find((i) => i.id === focusedId) ?? null

  useKeyboardShortcut('j', 'Next item', () => moveFocus(1), 'list')
  useKeyboardShortcut('k', 'Previous item', () => moveFocus(-1), 'list')
  useKeyboardShortcut(
    'enter',
    'Open focused item',
    () => {
      if (!focused) return
      if (focused.kind === 'mention' && focused.notificationId != null) {
        void runAction(focused.id, () => dismissMentionInbox(workspaceSlug, focused.notificationId!))
      } else if (focused.kind === 'review_run' && focused.runId != null) {
        void runAction(focused.id, () => dismissRunInbox(workspaceSlug, focused.runId!))
      }
      if (focused.href) router.push(focused.href)
    },
    'list',
  )
  useKeyboardShortcut(
    'y',
    'Approve focused approval',
    () => {
      if (focused?.kind === 'approval' && focused.approvalId != null) {
        const optionId = focused.approvalOptions?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')?.optionId
        void runAction(focused.id, () => approveApprovalInbox(workspaceSlug, focused.approvalId!, optionId))
      }
    },
    'list',
  )
  useKeyboardShortcut(
    'n',
    'Deny focused approval',
    () => {
      if (focused?.kind === 'approval' && focused.approvalId != null) {
        void runAction(focused.id, () => denyApprovalInbox(workspaceSlug, focused.approvalId!))
      }
    },
    'list',
  )
  useKeyboardShortcut(
    'r',
    'Retry focused failed run',
    () => {
      if (focused?.kind === 'failed_run' && focused.canRetry && focused.runId != null) {
        void runAction(focused.id, () => retryRunInbox(workspaceSlug, focused.runId!))
      }
    },
    'list',
  )
  useKeyboardShortcut(
    'e',
    'Dismiss focused item',
    () => {
      if (!focused) return
      if ((focused.kind === 'failed_run' || focused.kind === 'review_run') && focused.runId != null) {
        void runAction(focused.id, () => dismissRunInbox(workspaceSlug, focused.runId!))
      } else if (focused.kind === 'mention' && focused.notificationId != null) {
        void runAction(focused.id, () => dismissMentionInbox(workspaceSlug, focused.notificationId!))
      }
    },
    'list',
  )

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Check />}
        title="Inbox zero"
        description="Nothing needs you right now — approvals, failed runs, review-ready diffs, and mentions all show up here the moment they do."
      />
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {errorMessage && (
        <p className="rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{errorMessage}</p>
      )}
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            isFocused={item.id === focusedId}
            isPending={pendingIds.has(item.id)}
            onFocus={() => setFocusedId(item.id)}
            onApprove={(optionId) => runAction(item.id, () => approveApprovalInbox(workspaceSlug, item.approvalId!, optionId))}
            onDeny={() => runAction(item.id, () => denyApprovalInbox(workspaceSlug, item.approvalId!))}
            onRetry={() => runAction(item.id, () => retryRunInbox(workspaceSlug, item.runId!))}
            onDismissRun={() => runAction(item.id, () => dismissRunInbox(workspaceSlug, item.runId!))}
            onDismissMention={() => runAction(item.id, () => dismissMentionInbox(workspaceSlug, item.notificationId!))}
          />
        ))}
      </ul>
    </div>
  )
}

function InboxRow({
  item,
  isFocused,
  isPending,
  onFocus,
  onApprove,
  onDeny,
  onRetry,
  onDismissRun,
  onDismissMention,
}: {
  item: InboxItem
  isFocused: boolean
  isPending: boolean
  onFocus: () => void
  onApprove: (optionId?: string) => void
  onDeny: () => void
  onRetry: () => void
  onDismissRun: () => void
  onDismissMention: () => void
}) {
  const meta = KIND_META[item.kind]
  const Icon = meta.icon
  const allowOption = item.approvalOptions?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')

  return (
    <li
      data-inbox-row={item.id}
      onClick={onFocus}
      className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 transition-colors ${
        isFocused ? 'border-border bg-muted' : 'border-transparent hover:bg-muted/50'
      } ${isPending ? 'opacity-50' : ''}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Badge variant="outline" className="mt-0.5 shrink-0 gap-1">
          <Icon size={11} />
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          {item.href ? (
            <Link
              href={item.href}
              onClick={() => {
                if (item.kind === 'review_run') onDismissRun()
                if (item.kind === 'mention') onDismissMention()
              }}
              className="truncate text-sm font-medium text-foreground hover:underline"
            >
              {item.headline}
            </Link>
          ) : (
            <p className="truncate text-sm font-medium text-foreground">{item.headline}</p>
          )}
          {item.subline && <p className="truncate text-xs text-muted-foreground">{item.subline}</p>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{formatTimestamp(item.time)}</span>

        {item.kind === 'approval' && (
          <>
            <Button type="button" size="xs" disabled={isPending} onClick={() => onApprove(allowOption?.optionId)}>
              <Check /> Approve (y)
            </Button>
            <Button type="button" size="xs" variant="destructive" disabled={isPending} onClick={onDeny}>
              <X /> Deny (n)
            </Button>
          </>
        )}

        {item.kind === 'failed_run' && (
          <>
            {item.canRetry && (
              <Button type="button" size="xs" disabled={isPending} onClick={onRetry}>
                <RotateCcw /> Retry (r)
              </Button>
            )}
            <Button type="button" size="xs" variant="outline" disabled={isPending} onClick={onDismissRun}>
              Dismiss (e)
            </Button>
          </>
        )}

        {item.kind === 'review_run' && (
          <Button type="button" size="xs" variant="outline" disabled={isPending} onClick={onDismissRun}>
            Dismiss (e)
          </Button>
        )}

        {item.kind === 'mention' && (
          <Button type="button" size="xs" variant="outline" disabled={isPending} onClick={onDismissMention}>
            Dismiss (e)
          </Button>
        )}
      </div>
    </li>
  )
}
