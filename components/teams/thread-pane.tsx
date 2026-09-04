'use client'

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import type { ChannelApproval, TeamMessageKind, TeamTask } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { PaneBoundary } from '@/components/ui/pane-boundary'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { formatRelativeTime } from '@/lib/relative-time'
import { postChannelMessageAction, toggleReactionAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import {
  isGroupedWith,
  makeOptimisticMessage,
  parseMentionsLocally,
  runLinkFor,
  slotById,
  taskChipFor,
  type ChannelRunLink,
  type PendingReply,
  type RoomFeedMessage,
  type TeamSlotView,
} from './shared'
import { PaneDivider, useResizablePane } from '@/components/ui/resizable-pane'
import { ApprovalStrip } from './approval-strip'
import { ConnectStrip } from './connect-strip'
import { isConnectRequest } from '@/lib/hermes/connect-request'
import { MessageRow } from './message-row'
import { MessageComposer } from './message-composer'
import { PendingReplyRow } from './pending-reply-row'

/**
 * A thread, BESIDE the feed.
 *
 * Never a modal, and that is a decision rather than a style: a thread is a
 * branch of a conversation that is still happening, and covering the
 * conversation to read the branch is how you lose the context that made the
 * branch make sense. Slack learned this the same way.
 *
 * There is exactly one level. `postChannelMessage` re-points a reply-to-a-reply
 * at the ROOT, so this pane is always root-plus-replies and no renderer here
 * has to handle unbounded depth for a case that adds nothing.
 */
export function ThreadPane({
  workspaceId,
  workspaceSlug,
  teamId,
  rootId,
  messages,
  slots,
  tasks,
  runs,
  pending,
  approvals,
  currentUserId,
  onApprovalSettled,
  mySlotId,
  onClose,
  onDispatched,
  onOptimisticInsert,
  onOptimisticSettle,
  onOptimisticDiscard,
  onPatchMessage,
  onDismissPending,
  onOpenTask,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  rootId: number
  /** Root first, then replies in order — exactly what `listThread` returns. */
  messages: RoomFeedMessage[]
  slots: TeamSlotView[]
  tasks: TeamTask[]
  runs: Map<number, ChannelRunLink>
  /** The whole room's pending replies; this pane renders the ones whose
   * answer is destined for THIS thread. Passed whole rather than pre-filtered
   * so the room stays the single owner of that list. */
  pending: PendingReply[]
  /** Blocked runs for the whole room; this pane shows the ones belonging to
   * THIS thread. Same list the channel renders, so approving in one place and
   * approving in the other are visibly the same request. */
  approvals: ChannelApproval[]
  currentUserId: number
  onApprovalSettled: (externalId: string) => void
  mySlotId: number | null
  onClose: () => void
  /** R12-P3.1 - a reply paints before the server confirms it, exactly as a
   * root message does. A thread is a conversation too. */
  onOptimisticInsert: (row: RoomFeedMessage) => void
  onOptimisticSettle: (pendingKey: string, real: RoomFeedMessage | null, failure?: string) => void
  onOptimisticDiscard: (pendingKey: string) => string | null
  onDispatched: (input: {
    message: RoomFeedMessage
    dispatched: Array<{ slotId: number; displayName: string; runId: number }>
    skipped: Array<{ slotId: number; displayName: string; reason: string }>
  }) => void
  onPatchMessage: (id: number, patch: Partial<RoomFeedMessage>) => void
  onDismissPending: (runId: number) => void
  onOpenTask: (taskId: number) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const root = messages[0] ?? null
  const replies = messages.slice(1)
  /**
   * The ghosts that belong here.
   *
   * A mention dispatched with `thread_root_id = rootId` will answer INTO this
   * pane, so this is where its live text belongs — the feed shows the same
   * ghost under the message that started it, and the two are the same run
   * rendered twice rather than two competing stories.
   */
  const threadPending = useMemo(
    () => pending.filter((row) => row.threadRootId === rootId),
    [pending, rootId],
  )

  // A thread pane opens at its newest reply — you came here to read the end of
  // a branch, not the start of one you have already seen in the feed.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, rootId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Remembered per browser, not per thread: how wide you like this pane is a
  // preference about the layout, and resetting it every time you opened a
  // different thread would feel broken.
  const pane = useResizablePane({ storageKey: 'notionharness.channel.thread.width', defaultWidth: 384, min: 300, max: 900 })

  async function send(input: { body: string; kind: TeamMessageKind; toSlotId: number | null }) {
    // Same rule as the feed: the reply is on screen before the write starts.
    const optimistic = makeOptimisticMessage({
      teamId,
      fromSlotId: mySlotId,
      toSlotId: null,
      kind: input.kind,
      body: input.body,
      threadRootId: rootId,
      mentions: parseMentionsLocally(input.body, slots),
    })
    onOptimisticInsert(optimistic)

    try {
      const result = unwrap(
        await postChannelMessageAction({
          workspaceId,
          teamId,
          body: input.body,
          // A reply inherits the thread. `threadRootId` is validated against
          // this channel inside `postChannelMessage`, so a root id from another
          // room is refused in the data layer as well as by the action's guards.
          threadRootId: rootId,
        }),
      )
      // Settled in place rather than appended: `onAppendReply` would add the
      // real row beside the placeholder and the reply would show twice.
      onOptimisticSettle(optimistic.pendingKey!, {
        ...result.message,
        systemKind: null,
        undeliverableAt: null,
        addresseeMissing: false,
      })
      // A reply can name an agent too, and the same silence bug applies to it.
      onDispatched({
        message: result.message,
        dispatched: result.dispatched ?? [],
        skipped: result.mentionsSkipped ?? [],
      })
    } catch (error) {
      onOptimisticSettle(
        optimistic.pendingKey!,
        null,
        error instanceof Error ? error.message : 'That reply was not sent.',
      )
    }
  }

  function retrySend(pendingKey: string) {
    const body = onOptimisticDiscard(pendingKey)
    if (body) void send({ body, kind: 'status', toSlotId: null })
  }

  async function toggleReaction(messageId: number, emoji: string) {
    if (mySlotId == null) return
    try {
      const { added } = unwrap(await toggleReactionAction({ workspaceId, teamId, messageId, emoji }))
      const message = messages.find((m) => m.id === messageId)
      if (!message) return
      const existing = message.reactions.find((r) => r.emoji === emoji)
      const reactions = added
        ? existing
          ? message.reactions.map((r) =>
              r.emoji === emoji ? { ...r, count: r.count + 1, actorSlotIds: [...r.actorSlotIds, mySlotId] } : r,
            )
          : [...message.reactions, { emoji, count: 1, actorSlotIds: [mySlotId] }]
        : message.reactions
            .map((r) =>
              r.emoji === emoji
                ? { ...r, count: r.count - 1, actorSlotIds: r.actorSlotIds.filter((id) => id !== mySlotId) }
                : r,
            )
            .filter((r) => r.count > 0)
      onPatchMessage(messageId, { reactions })
    } catch (error) {
      toast({
        title: 'Reaction not saved',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      {/* R12-P3.4 - the divider IS the boundary. One hairline, a 9px invisible
          grab area centred on it, and no gutter on either side, so the two
          panes sit flush and the seam between them is the control. */}
      <PaneDivider label="Resize the thread" dragging={pane.dragging} {...pane.dividerProps} />
      <aside
        ref={pane.paneRef as React.RefObject<HTMLElement>}
        style={{ width: pane.width }}
        className="flex min-h-0 shrink-0 flex-col rounded-xl border border-black/10 bg-white/40 dark:border-white/10 dark:bg-white/[.02]"
      >
      {/* R12-P1.2 — the thread is a column BESIDE a live feed, and a
          reply that will not render is not a reason to take the conversation
          down with it. There is no route segment here to hold a boundary, so
          it is held in place. */}
      <PaneBoundary label="The thread">
        <header className="flex shrink-0 items-center gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Thread</span>
            <span className="block text-[11px] text-black/45 dark:text-white/45">
              {replies.length === 0
                ? 'No replies yet — yours starts it.'
                : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} · last ${formatRelativeTime(
                    replies[replies.length - 1].createdAt,
                  )}`}
            </span>
          </span>
          <Button type="button" size="icon-xs" variant="ghost" onClick={onClose} title="Close thread (Esc)">
            <X size={13} />
          </Button>
        </header>

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
          {root == null ? (
            <p className="py-8 text-center text-xs text-black/40 dark:text-white/40">
              That thread is no longer in this channel.
            </p>
          ) : (
            <ul>
              <MessageRow
                message={root}
                grouped={false}
                slots={slots}
                mySlotId={mySlotId}
                taskChip={taskChipFor(tasks, slots, root.taskId)}
                runSessionId={runLinkFor(root, runs, slots)?.sessionId ?? null}
                runIsExact={runLinkFor(root, runs, slots)?.exact ?? false}
                workspaceSlug={workspaceSlug}
                focused={false}
                threadOpen
                // The root is already open; its own "N replies" button would be a
                // link to where you are standing.
                onOpenThread={() => undefined}
                onOpenTask={onOpenTask}
                onMakeTask={null}
                onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                busy={false}
              />
              {approvals
                .filter((row) => row.rootMessageId === rootId)
                .map((row) => {
                  const slot = slotById(slots, row.slotId)
                  // Same row, same poll, same endpoint — see channel-view.
                  const Strip = isConnectRequest(row.externalId) ? ConnectStrip : ApprovalStrip
                  return (
                    <li key={`approval-${row.externalId}`} className="px-3">
                      <Strip
                        approval={row}
                        slotName={slot?.displayName ?? null}
                        canDecide={row.requestedUserId === currentUserId}
                        holderName={slots.find((s) => s.userId === row.requestedUserId)?.displayName ?? null}
                        workspaceSlug={workspaceSlug}
                        onSettled={onApprovalSettled}
                      />
                    </li>
                  )
                })}
              {replies.length > 0 && (
                <li className="my-2 flex items-center gap-2 px-3">
                  <span aria-hidden className="h-px flex-1 bg-black/[.08] dark:bg-white/[.10]" />
                  <span className="shrink-0 text-[11px] text-black/40 dark:text-white/40">
                    {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-black/[.08] dark:bg-white/[.10]" />
                </li>
              )}
              {replies.map((reply, index) => (
                <MessageRow
                  key={reply.id}
                  message={reply}
                  grouped={isGroupedWith(index === 0 ? null : replies[index - 1], reply)}
                  slots={slots}
                  mySlotId={mySlotId}
                  taskChip={taskChipFor(tasks, slots, reply.taskId)}
                  runSessionId={runLinkFor(reply, runs, slots)?.sessionId ?? null}
                  runIsExact={runLinkFor(reply, runs, slots)?.exact ?? false}
                  workspaceSlug={workspaceSlug}
                  focused={false}
                  threadOpen={false}
                  onOpenThread={() => undefined}
                  onOpenTask={onOpenTask}
                  onMakeTask={null}
                  onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                  onRetrySend={retrySend}
                  onDiscardSend={(key) => void onOptimisticDiscard(key)}
                  busy={false}
                />
              ))}
              {threadPending.map((row) => (
                <PendingReplyRow
                  key={row.runId}
                  workspaceId={workspaceId}
                  workspaceSlug={workspaceSlug}
                  teamId={teamId}
                  pending={row}
                  slots={slots}
                  onDismiss={onDismissPending}
                />
              ))}
            </ul>
          )}
        </div>

        {root != null && (
          <MessageComposer
            slots={slots}
            placeholder="Reply…"
            // A reply inherits the conversation's kind and audience: a per-reply
            // "instruction to Reviewer" inside somebody else's thread is a
            // distinction nobody asked for and a second way to say the same thing.
            showKind={false}
            showRecipient={false}
            autoFocus
            onSend={send}
          />
        )}
      </PaneBoundary>
      </aside>
    </>
  )
}
