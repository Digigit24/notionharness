'use client'

// R14-P0.9 — the `channel_mention` kind's detail-pane body: the row's thread,
// rendered beside the list instead of behind a navigation.
//
// Reuses `MessageRow` — the exact renderer `components/teams/thread-pane.tsx`
// uses — rather than the pane itself, per this unit's brief: `ThreadPane` is
// wired to a live channel room (SSE-fed roster, task board, run map, a reply
// composer) that has no counterpart on this route. What this fetches instead
// is the smallest self-contained read that lets `MessageRow` render truthfully
// — one thread, the channel's roster, and the reader's own slot (so "you
// reacted" and mention highlighting are correct) — via the new
// `getInboxThreadPreview` action. Task chips and "See full run" links are
// left off: both need data (the task board, the run map) this lightweight
// preview deliberately does not fetch, and a chip linking to a stale or
// unfetched task would be worse than no chip.
//
// Lightly interactive, not fully: reactions work (the exact toggle
// `ThreadPane` uses, `applyReactionToggle` included, so the two cannot
// disagree about the resulting count) but there is no reply composer here —
// replying is the "full context" action, via "Open in channel" below.
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { unwrap, isFailureEnvelope } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { formatTimestamp } from '@/lib/relative-time'
import { MessageRow } from '@/components/teams/message-row'
import { applyReactionToggle, isGroupedWith } from '@/components/teams/shared'
import { toggleReactionAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import {
  getInboxThreadPreview,
  type InboxThreadPreview as ThreadPreviewData,
} from '@/app/(app)/workspace/[workspaceSlug]/inbox/actions'
import { relationshipLabel, type InboxItem } from './inbox-list'

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ThreadPreviewData }

export function InboxThreadPreview({
  item,
  workspaceSlug,
  onOpen,
}: {
  item: InboxItem
  workspaceSlug: string
  onOpen: () => void
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })

  // Re-fetches whenever the SELECTED message changes — j/k moving to the next
  // channel-mention row is exactly the case this effect exists for, since
  // selection is now a state change rather than a navigation that would have
  // remounted this component for free.
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    if (item.channelMessageId == null) {
      setState({ status: 'error', message: 'This mention has no message to show.' })
      return
    }
    void (async () => {
      const result = await getInboxThreadPreview(workspaceSlug, item.channelMessageId!)
      if (cancelled) return
      setState(isFailureEnvelope(result) ? { status: 'error', message: result.__failure.message } : { status: 'ready', data: result })
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceSlug, item.channelMessageId])

  async function toggleReaction(messageId: number, emoji: string) {
    if (state.status !== 'ready' || state.data.mySlotId == null) return
    const { workspaceId, teamId, mySlotId } = state.data
    try {
      const { added } = unwrap(await toggleReactionAction({ workspaceId, teamId, messageId, emoji }))
      setState((prev) => {
        if (prev.status !== 'ready') return prev
        const message = prev.data.messages.find((m) => m.id === messageId)
        if (!message) return prev
        const reactions = applyReactionToggle(message.reactions, emoji, mySlotId, added)
        return {
          ...prev,
          data: { ...prev.data, messages: prev.data.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)) },
        }
      })
    } catch (error) {
      toast({
        title: 'Reaction not saved',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">{relationshipLabel(item)}</p>
          <h2 className="truncate text-sm font-semibold text-foreground">{item.headline}</h2>
          <p className="text-[11px] text-muted-foreground">{formatTimestamp(item.time)}</p>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={onOpen} className="shrink-0 gap-1">
          <ExternalLink size={11} />
          Open in channel
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {state.status === 'loading' && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading thread…</p>
        )}
        {state.status === 'error' && <p className="px-3 py-6 text-center text-xs text-destructive">{state.message}</p>}
        {state.status === 'ready' && (
          <ul>
            {state.data.messages.map((message, index) => (
              <MessageRow
                key={message.id}
                message={message}
                grouped={isGroupedWith(index === 0 ? null : state.data.messages[index - 1], message)}
                slots={state.data.slots}
                mySlotId={state.data.mySlotId}
                taskChip={null}
                runSessionId={null}
                runIsExact={false}
                workspaceSlug={workspaceSlug}
                focused={false}
                threadOpen
                onOpenThread={() => undefined}
                // No task board fetched for this preview — opening one falls
                // back to the same "full context" action the header offers.
                onOpenTask={onOpen}
                onMakeTask={null}
                onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                busy={false}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
