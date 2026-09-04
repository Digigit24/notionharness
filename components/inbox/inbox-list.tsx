'use client'

// ROADMAP B5.2 (Batch B-5 "Attention") / R14-P0.9 — the Inbox's real list
// surface: one chronological, keyboard-navigable, dismissible stream.
//
// R14-P0.9 CHANGE: this component is now a CONTROLLED, presentational list.
// Selection, the item array (with its optimistic removals) and every action's
// wiring moved up to `inbox-workspace.tsx`, because the right-side preview
// pane needs to read and act on the SAME selection and the SAME item list —
// two independent copies of that state is how a list and its own preview pane
// disagree with each other. This file now owns only: what a row looks like,
// and the `j`/`k`-under-the-'list'-scope keyboard pattern's RENDER half (the
// shortcuts themselves are registered by the workspace, which owns focus).
//
// THE OTHER CHANGE: a row no longer navigates on click or Enter. It used to
// call `router.push(item.href)` — a full page navigation away from the list —
// which is exactly the dead end R14-P0.9 exists to fix. Selecting a row now
// only ever changes which item the right pane shows; `router.push` is used
// exactly once in this whole feature, for the detail pane's own explicit
// "Open in channel" / "Open task" action, never for basic row selection.
import { AlertTriangle, AtSign, Check, FileDiff, Hash, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { ApprovalOption } from '@/collections/Approvals'
import { formatTimestamp } from '@/lib/relative-time'

// `channel_mention` is a separate kind from `mention` on purpose: they come
// from different producers (a channel message vs. a Payload notification),
// clear through different mechanisms (a per-slot read cursor vs. isRead), and
// only one of them has a #channel to name. Folding them together would mean
// one of those three behaviours becoming a lie.
export type InboxItemKind = 'approval' | 'failed_run' | 'review_run' | 'mention' | 'channel_mention'

export interface InboxItem {
  id: string
  kind: InboxItemKind
  headline: string
  subline: string | null
  time: string
  href: string | null
  approvalId?: number
  approvalOptions?: ApprovalOption[]
  /** The ACP `session/request_permission` id `PermissionCard` needs to POST a
   * decision — see `inbox-approval-preview.tsx`. Distinct from `approvalId`
   * (the `approvals` collection's numeric row id, used by this route's own
   * `approveApprovalInbox`/`denyApprovalInbox`) — the two id spaces are not
   * interchangeable, see `app/api/approvals/route.ts`'s own comment on why. */
  externalId?: string
  runId?: number
  canRetry?: boolean
  /** The Work session behind a run item, when it has one — lets the detail
   * pane offer "See full run" the same way `MessageRow` does, with no extra
   * fetch: `runToItem` already holds the `Run` row this comes from. */
  sessionId?: number | null
  notificationId?: number
  /** The mentioning message. The only id the channel-mention action takes —
   * team and slot are re-derived from it server-side. */
  channelMessageId?: number
  /** channel_mention only — the channel named in the relationship label and
   * the detail pane's "Open in #channel" action. */
  channelName?: string
  /** channel_mention only — true when the mention is on a reply rather than
   * a thread root, so the relationship label can say "Thread in #x" instead
   * of "Mentioned in #x". */
  inThread?: boolean
}

const KIND_META: Record<InboxItemKind, { label: string; icon: typeof ShieldAlert }> = {
  approval: { label: 'Approval', icon: ShieldAlert },
  failed_run: { label: 'Failed run', icon: AlertTriangle },
  review_run: { label: 'Review-ready', icon: FileDiff },
  mention: { label: 'Mention', icon: AtSign },
  channel_mention: { label: 'Channel', icon: Hash },
}

/**
 * The row's relationship to the reader, stated before its content — "Thread
 * in #general", "Mentioned in #eng" — the pattern R14-P0.9 asks for. Driven
 * entirely by `InboxItemKind` (a closed, typed set) plus the structured
 * fields above, never by re-parsing `headline`'s free text.
 */
export function relationshipLabel(item: InboxItem): string {
  switch (item.kind) {
    case 'approval':
      return 'Needs your approval'
    case 'failed_run':
      return 'Run failed'
    case 'review_run':
      return 'Ready for review'
    case 'mention':
      return 'Mentioned you'
    case 'channel_mention':
      return item.channelName
        ? item.inThread
          ? `Thread in #${item.channelName}`
          : `Mentioned in #${item.channelName}`
        : 'Channel mention'
  }
}

export function InboxList({
  items,
  selectedId,
  onSelect,
  handlersFor,
}: {
  items: InboxItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Bound per-item action callbacks, built once per render by the workspace
   * (which is the one place that knows how to turn an id into a server call
   * with optimistic removal + rollback). Kept as a function rather than a
   * pre-built map so a row never carries a closure it does not use. */
  handlersFor: (item: InboxItem) => RowHandlers
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Check />}
        title="Inbox zero"
        description="Nothing needs you right now — approvals, failed runs, review-ready diffs, and every mention of you across every channel all show up here the moment they do."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <InboxRow
          key={item.id}
          item={item}
          isSelected={item.id === selectedId}
          onSelect={() => onSelect(item.id)}
          handlers={handlersFor(item)}
        />
      ))}
    </ul>
  )
}

export interface RowHandlers {
  onApprove: (optionId?: string) => void
  onDeny: () => void
  onRetry: () => void
  onDismissRun: () => void
  onDismissMention: () => void
  onMarkChannelRead: () => void
}

function InboxRow({
  item,
  isSelected,
  onSelect,
  handlers,
}: {
  item: InboxItem
  isSelected: boolean
  onSelect: () => void
  handlers: RowHandlers
}) {
  const meta = KIND_META[item.kind]
  const Icon = meta.icon
  const allowOption = item.approvalOptions?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')

  return (
    <li
      data-inbox-row={item.id}
      onClick={onSelect}
      className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 transition-colors ${
        isSelected ? 'border-border bg-muted' : 'border-transparent hover:bg-muted/50'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Badge variant="outline" className="mt-0.5 shrink-0 gap-1">
          <Icon size={11} />
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          {/* The relationship, before the content — "Thread in #general"
              ahead of the headline it belongs to, never folded into it. */}
          <p className="truncate text-[11px] font-medium text-muted-foreground">{relationshipLabel(item)}</p>
          {/* A button, not a `<Link>` — selecting a row is a state change
              (which item the right pane shows), never a navigation. The
              detail pane's own "Open" action is the only place this feature
              calls `router.push`. */}
          <button
            type="button"
            onClick={onSelect}
            className="truncate text-left text-sm font-medium text-foreground hover:underline"
          >
            {item.headline}
          </button>
          {item.subline && <p className="truncate text-xs text-muted-foreground">{item.subline}</p>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{formatTimestamp(item.time)}</span>

        {item.kind === 'approval' && (
          <>
            <Button type="button" size="xs" onClick={() => handlers.onApprove(allowOption?.optionId)}>
              <Check /> Approve (y)
            </Button>
            <Button type="button" size="xs" variant="destructive" onClick={handlers.onDeny}>
              <X /> Deny (n)
            </Button>
          </>
        )}

        {item.kind === 'failed_run' && (
          <>
            {item.canRetry && (
              <Button type="button" size="xs" onClick={handlers.onRetry}>
                <RotateCcw /> Retry (r)
              </Button>
            )}
            <Button type="button" size="xs" variant="outline" onClick={handlers.onDismissRun}>
              Dismiss (e)
            </Button>
          </>
        )}

        {item.kind === 'review_run' && (
          <Button type="button" size="xs" variant="outline" onClick={handlers.onDismissRun}>
            Dismiss (e)
          </Button>
        )}

        {item.kind === 'mention' && (
          <Button type="button" size="xs" variant="outline" onClick={handlers.onDismissMention}>
            Dismiss (e)
          </Button>
        )}

        {/* "Mark read", not "Dismiss": the only mechanism a channel message has
            is the reader's per-slot read cursor, so this catches you up in that
            channel through this message rather than hiding one row. The label
            has to say what actually happens — see the action's own note. */}
        {item.kind === 'channel_mention' && (
          <Button type="button" size="xs" variant="outline" onClick={handlers.onMarkChannelRead}>
            Mark read (e)
          </Button>
        )}
      </div>
    </li>
  )
}
