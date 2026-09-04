'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Hash, UserPlus } from 'lucide-react'
import type { TeamMessageKind, TeamTask } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import {
  postChannelMessageAction,
  toggleReactionAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { MessageComposer } from './message-composer'
import { MessageRow } from './message-row'
import {
  applyReactionToggle,
  dayKeyOf,
  formatDayLabel,
  isGroupedWith,
  type RoomFeedMessage,
  type TeamSlotView,
} from './shared'

/**
 * The channel feed.
 *
 * R6.5 IS BINDING AND THIS FILE IS WHERE IT IS HONOURED: this is a capped
 * React list over TYPED ROWS, and nothing in it imports the editor. A CRDT is
 * the wrong substrate for a high-frequency append-only log — every append
 * becomes a Yjs update and a persistence write, and the document grows without
 * bound in memory on every open tab. The CANVAS is BlockSuite; the FEED is
 * not, and the two never meet.
 *
 * The cap is a window, not a limit on the data: older roots are still held in
 * memory and mounted on demand by "Show earlier". True windowing — mounting
 * only what intersects the viewport — needs a virtualiser, and this unit may
 * not add a dependency; a bounded ceiling keeps the DOM in the same order of
 * magnitude a virtualiser would, which is what the rule protects.
 */
const WINDOW_SIZE = 150

export function ChannelView({
  workspaceId,
  teamId,
  slots,
  mySlotId,
  feed,
  tasks,
  unreadBoundary,
  threadRootId,
  onOpenThread,
  onPosted,
  onPatchMessage,
  onSeen,
  onJoin,
  joining,
}: {
  workspaceId: number
  teamId: number
  slots: TeamSlotView[]
  mySlotId: number | null
  feed: RoomFeedMessage[]
  tasks: TeamTask[]
  /**
   * The read cursor as it stood when the channel was OPENED, frozen by the
   * room. The divider must not chase the cursor: marking the feed read moves
   * `last_read_message_id` forward, and a live boundary would make the "new
   * messages" line vanish the instant you looked at it — which is exactly when
   * you want to see where you left off.
   */
  unreadBoundary: number | null
  threadRootId: number | null
  onOpenThread: (rootId: number) => void
  onPosted: (message: RoomFeedMessage) => void
  onPatchMessage: (id: number, patch: Partial<RoomFeedMessage>) => void
  /** Called with the newest id the reader has actually LOOKED at. */
  onSeen: (messageId: number) => void
  onJoin: () => void
  joining: boolean
}) {
  const [cap, setCap] = useState(WINDOW_SIZE)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLLIElement>(null)
  const pinnedToBottom = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const visible = useMemo(() => (feed.length > cap ? feed.slice(-cap) : feed), [feed, cap])
  const hidden = feed.length - visible.length
  const taskSubjectById = useMemo(() => new Map(tasks.map((t) => [t.id, t.subject])), [tasks])
  const lastId = feed.length > 0 ? feed[feed.length - 1].id : 0

  /**
   * The first message that is new TO YOU.
   *
   * Your own messages never count: you have plainly seen what you just wrote,
   * and a divider that sits above your own line is the classic bug that makes
   * people stop trusting the marker.
   */
  const firstUnreadId = useMemo(() => {
    if (unreadBoundary == null) return null
    const first = feed.find((m) => m.id > unreadBoundary && m.fromSlotId !== mySlotId)
    return first?.id ?? null
  }, [feed, unreadBoundary, mySlotId])

  // Sticky-bottom, the way a chat client behaves: follow new messages only
  // while the reader is already at the bottom. Yanking someone back down while
  // they are reading history is the single worst thing a feed can do.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !pinnedToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [visible.length])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      pinnedToBottom.current = bottom
      setAtBottom(bottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // On open, land on the divider rather than the bottom when there is one.
  // "Where did I leave off" is the question someone opening a busy channel is
  // actually asking; scrolling past it to the newest line answers a different
  // one and makes them scroll back.
  const landedRef = useRef(false)
  useLayoutEffect(() => {
    if (landedRef.current || firstUnreadId == null) return
    const el = dividerRef.current
    if (!el) return
    landedRef.current = true
    el.scrollIntoView({ block: 'center' })
    pinnedToBottom.current = false
    setAtBottom(false)
  }, [firstUnreadId])

  /**
   * Marking read when the feed is actually SEEN.
   *
   * NOT on mount. A room mounted in a background tab, or behind the Board
   * view, or scrolled up in history, has not been read by anybody — and
   * clearing the badge for it is how an unread count becomes a number people
   * learn to ignore. The three conditions are all real: the document is
   * visible, this component is mounted (so the Channel tab is the one on
   * screen), and the BOTTOM of the list is in the viewport.
   */
  useEffect(() => {
    const sentinel = bottomRef.current
    if (!sentinel || lastId === 0) return
    let seen = false
    const report = () => {
      if (!seen || document.visibilityState !== 'visible') return
      onSeen(lastId)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        seen = entries.some((e) => e.isIntersecting)
        report()
      },
      { root: scrollerRef.current, threshold: 0.1 },
    )
    observer.observe(sentinel)
    document.addEventListener('visibilitychange', report)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', report)
    }
  }, [lastId, onSeen])

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedToBottom.current = true
    setAtBottom(true)
  }, [])

  /**
   * A reaction, applied locally from what the server already told us.
   *
   * `toggleReactionAction` returns `added` and the actor's slot id, so the new
   * counts and the "you reacted" state are both derivable without a second
   * read — which is the point of `toggleReaction` returning `actorSlotIds` on
   * the row in the first place. Not optimistic-then-reconciled: the write is
   * one indexed statement, and showing a reaction that has not landed is how a
   * count ends up disagreeing with the next poll.
   */
  const toggleReaction = useCallback(
    async (messageId: number, emoji: string) => {
      if (mySlotId == null) return
      try {
        const { added, actorSlotId } = await toggleReactionAction({ workspaceId, teamId, messageId, emoji })
        const message = feed.find((m) => m.id === messageId)
        if (!message) return
        onPatchMessage(messageId, {
          reactions: applyReactionToggle(message.reactions, emoji, actorSlotId, added),
        })
      } catch (error) {
        toast({
          title: 'Reaction not saved',
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      }
    },
    [workspaceId, teamId, mySlotId, feed, onPatchMessage],
  )

  const send = useCallback(
    async (input: { body: string; kind: TeamMessageKind; toSlotId: number | null }) => {
      try {
        const result = await postChannelMessageAction({
          workspaceId,
          teamId,
          body: input.body,
          kind: input.kind,
          toSlotId: input.toSlotId,
          threadRootId: null,
        })
        // Appended from the returned row rather than refetching the channel:
        // the insert already told us exactly what landed, and re-reading the
        // room to show a message we are holding is the round trip D0 forbids.
        onPosted(result.message)
        pinnedToBottom.current = true
        setAtBottom(true)
      } catch (error) {
        toast({
          title: 'Message not sent',
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      }
    },
    [workspaceId, teamId, onPosted],
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-black/10 dark:border-white/10">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {feed.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span
              aria-hidden
              className="flex size-10 items-center justify-center rounded-xl bg-black/[.05] text-black/40 dark:bg-white/[.07] dark:text-white/40"
            >
              <Hash size={20} />
            </span>
            <p className="text-sm font-medium">This is the beginning of the channel.</p>
            <p className="max-w-sm text-xs text-black/45 dark:text-white/45">
              Anything you write here goes to every member. Address one member to send a directed note, and use{' '}
              <span className="font-medium">@</span> to pull somebody into it.
            </p>
          </div>
        )}

        {hidden > 0 && (
          <div className="mb-2 text-center">
            <Button type="button" size="xs" variant="outline" onClick={() => setCap((c) => c + WINDOW_SIZE)}>
              Show {Math.min(hidden, WINDOW_SIZE)} earlier
            </Button>
          </div>
        )}

        <ul className="px-1.5">
          {visible.map((message, index) => {
            const previous = visible[index - 1] ?? null
            const newDay = previous == null || dayKeyOf(previous.createdAt) !== dayKeyOf(message.createdAt)
            const isFirstUnread = message.id === firstUnreadId
            return (
              // A Fragment, not a wrapper element: a <div> between <ul> and
              // <li> is invalid HTML and breaks list semantics for a screen
              // reader reading the conversation.
              <Fragment key={message.id}>
                {newDay && (
                  <li className="my-3 flex items-center gap-2 px-2" aria-hidden>
                    <span className="h-px flex-1 bg-black/[.08] dark:bg-white/[.10]" />
                    <span className="rounded-full border border-black/10 px-2 py-px text-[11px] text-black/45 dark:border-white/15 dark:text-white/45">
                      {formatDayLabel(message.createdAt)}
                    </span>
                    <span className="h-px flex-1 bg-black/[.08] dark:bg-white/[.10]" />
                  </li>
                )}
                {isFirstUnread && (
                  <li ref={dividerRef} className="my-2 flex items-center gap-2 px-2">
                    <span className="h-px flex-1 bg-red-500/50" />
                    <span className="rounded-full bg-red-500 px-2 py-px text-[10px] font-medium uppercase tracking-wide text-white">
                      New
                    </span>
                  </li>
                )}
                <MessageRow
                  message={message}
                  // A day divider or the unread line ends a run: a message
                  // whose header was hidden by grouping would sit under a
                  // divider with no author at all.
                  grouped={!newDay && !isFirstUnread && isGroupedWith(previous, message)}
                  slots={slots}
                  mySlotId={mySlotId}
                  taskSubject={message.taskId == null ? null : (taskSubjectById.get(message.taskId) ?? null)}
                  threadOpen={threadRootId === message.id}
                  onOpenThread={onOpenThread}
                  onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                  busy={false}
                />
              </Fragment>
            )
          })}
        </ul>
        <div ref={bottomRef} className="h-2" aria-hidden />
      </div>

      {!atBottom && feed.length > 0 && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="absolute bottom-28 left-1/2 -translate-x-1/2 shadow-md"
          onClick={jumpToBottom}
        >
          <ArrowDown size={12} />
          Jump to latest
        </Button>
      )}

      <div className="shrink-0 border-t border-black/10 pt-2 dark:border-white/10">
        {mySlotId == null && (
          // Stated, not hidden. Reactions and unread are both recorded against
          // a SLOT, so a reader with none genuinely cannot have either — and
          // saying so with the button that fixes it is better than silently
          // disabling half the row's controls.
          <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-black/10 px-2.5 py-1.5 text-xs text-black/55 dark:border-white/10 dark:text-white/55">
            <span className="min-w-0 flex-1">
              You are reading this channel without a slot in it. You can post, but reactions and unread need a
              member row.
            </span>
            <Button type="button" size="xs" variant="outline" disabled={joining} onClick={onJoin}>
              <UserPlus size={12} />
              {joining ? 'Joining…' : 'Join channel'}
            </Button>
          </div>
        )}
        <MessageComposer
          slots={slots}
          placeholder="Message the channel…"
          showKind
          showRecipient
          onSend={send}
        />
        <p className={cn('px-3 pb-2 text-[11px] text-black/35 dark:text-white/35')}>
          Written to the team mailbox. Nothing dispatches a run from here yet — a member picks this up the next time
          it polls its inbox through the team MCP surface (R6.2).
        </p>
      </div>
    </div>
  )
}
