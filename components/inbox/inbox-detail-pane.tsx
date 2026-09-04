'use client'

// R14-P0.9 — the right pane of the split view. Renders whichever item
// `inbox-workspace.tsx` says is selected, in place, with no navigation of its
// own except the explicit "Open" actions below (each one calls `onOpen`,
// which is the ONLY `router.push` in this feature — see the workspace's
// `openInFullContext`).
import { ExternalLink, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/relative-time'
import { relationshipLabel, type InboxItem, type RowHandlers } from './inbox-list'
import { InboxApprovalPreview } from './inbox-approval-preview'
import { InboxThreadPreview } from './inbox-thread-preview'

export function InboxDetailPane({
  item,
  workspaceSlug,
  handlers,
  onOpen,
  onResolvedExternally,
}: {
  item: InboxItem | null
  workspaceSlug: string
  handlers: RowHandlers | null
  onOpen: () => void
  onResolvedExternally: (id: string) => void
}) {
  if (!item || !handlers) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="text-sm font-medium text-foreground">Nothing selected</p>
        <p className="text-xs text-muted-foreground">Pick an item on the left — j/k moves, this pane follows.</p>
      </div>
    )
  }

  // The thread preview draws its own header (it needs the channel name and an
  // "Open in channel" action inline with the messages, the way
  // `components/teams/thread-pane.tsx` does), so it renders full-bleed rather
  // than under the shared header every other kind uses.
  if (item.kind === 'channel_mention') {
    return <InboxThreadPreview item={item} workspaceSlug={workspaceSlug} onOpen={onOpen} />
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">{relationshipLabel(item)}</p>
          <h2 className="truncate text-sm font-semibold text-foreground">{item.headline}</h2>
          <p className="text-[11px] text-muted-foreground">{formatTimestamp(item.time)}</p>
        </div>
        {item.href && (
          <Button type="button" size="xs" variant="outline" onClick={onOpen} className="shrink-0 gap-1">
            <ExternalLink size={11} />
            Open
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {item.kind === 'approval' && (
          <InboxApprovalPreview item={item} workspaceSlug={workspaceSlug} onResolvedExternally={onResolvedExternally} />
        )}

        {item.kind === 'mention' && (
          <div className="flex flex-col gap-3">
            {item.subline && <p className="whitespace-pre-wrap text-sm text-foreground/90">{item.subline}</p>}
            <div>
              <Button type="button" size="xs" variant="outline" onClick={handlers.onDismissMention}>
                Dismiss (e)
              </Button>
            </div>
          </div>
        )}

        {(item.kind === 'failed_run' || item.kind === 'review_run') && (
          <div className="flex flex-col gap-3">
            {item.subline && <p className="whitespace-pre-wrap text-sm text-foreground/90">{item.subline}</p>}
            {item.sessionId != null && (
              <a
                href={`/workspace/${workspaceSlug}/work?session=${item.sessionId}`}
                className="inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-xs text-black/45 hover:bg-black/[.05] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.08] dark:hover:text-white/70"
              >
                <ExternalLink size={11} />
                See full run
              </a>
            )}
            <div className="flex items-center gap-1.5">
              {item.kind === 'failed_run' && item.canRetry && (
                <Button type="button" size="xs" onClick={handlers.onRetry}>
                  <RotateCcw size={12} /> Retry (r)
                </Button>
              )}
              <Button type="button" size="xs" variant="outline" onClick={handlers.onDismissRun}>
                <X size={12} /> Dismiss (e)
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
