'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, AtSign, Hash, UserPlus } from 'lucide-react'
import type { ChannelApproval, TeamMessageKind, TeamTask } from '@/lib/broker'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { useKeyboardShortcut } from '@/lib/keyboard/use-keyboard-shortcut'
import {
  postChannelMessageAction,
  toggleReactionAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { ApprovalStrip } from './approval-strip'
import { ConnectStrip } from './connect-strip'
import { isConnectRequest } from '@/lib/hermes/connect-request'
import { MessageComposer, type SlashCommandRunner } from './message-composer'
import { TypingIndicatorRow } from './typing-indicator-row'
import { MessageRow } from './message-row'
import { PendingReplyRow } from './pending-reply-row'
import {
  applyReactionToggle,
  dayKeyOf,
  formatDayLabel,
  isGroupedWith,
  isOptimistic,
  makeOptimisticMessage,
  parseMentionsLocally,
  runLinkFor,
  slotById,
  taskChipFor,
  type ChannelRunLink,
  type PendingReply,
  type RoomFeedMessage,
  type SkippedMention,
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
  workspaceSlug,
  teamId,
  slots,
  mySlotId,
  feed,
  tasks,
  runs,
  pending,
  skipped,
  unreadBoundary,
  unreadAtOpen,
  mentionsAtOpen,
  threadRootId,
  onOpenThread,
  onOpenRun,
  onDispatched,
  onOptimisticInsert,
  onOptimisticSettle,
  onOptimisticDiscard,
  onPatchMessage,
  approvals,
  currentUserId,
  onApprovalSettled,
  typingSlotIds,
  onTyping,
  onDismissPending,
  onOpenTask,
  onMakeTask,
  onCommand,
  onSeen,
  onJoin,
  joining,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slots: TeamSlotView[]
  mySlotId: number | null
  feed: RoomFeedMessage[]
  tasks: TeamTask[]
  /** messageId → the run that message STARTED. See `runLinkFor`. */
  runs: Map<number, ChannelRunLink>
  /** Agents that have been woken and have not answered yet. */
  pending: PendingReply[]
  /** Mentions that deliberately woke nobody, with the server's reason. */
  skipped: SkippedMention[]
  /**
   * Permission requests blocking runs this channel started.
   *
   * On the CHANNEL and not only inside the thread: an agent that hits a
   * permission request goes quiet, and until now the only sign out here was a
   * reply count going up. The strip puts the decision where the person is.
   */
  approvals: ChannelApproval[]
  /** Only the person a request was raised against may decide it. */
  currentUserId: number
  /** Lets the room drop a decided request without waiting for the next poll. */
  onApprovalSettled: (externalId: string) => void
  /** R12-P3.2 — slot ids currently typing, ALREADY excluding this reader's
   * own — the room computes that once rather than every consumer re-deriving
   * "not me" from `mySlotId`. */
  typingSlotIds: number[]
  /** Fired by the composer, throttled, while there is uncommitted text. */
  onTyping: () => void
  /**
   * The read cursor as it stood when the channel was OPENED, frozen by the
   * room. The divider must not chase the cursor: marking the feed read moves
   * `last_read_message_id` forward, and a live boundary would make the "new
   * messages" line vanish the instant you looked at it — which is exactly when
   * you want to see where you left off.
   */
  unreadBoundary: number | null
  /**
   * Unread and mentions as the SERVER counted them when the channel opened.
   *
   * Frozen for the same reason the divider is frozen: `markChannelRead` fires
   * within a second of arriving, so a live count would show "0 new" to
   * somebody who has just walked in on twelve. New arrivals are added to it
   * from the rows themselves, which costs no request at all.
   */
  unreadAtOpen: number
  mentionsAtOpen: number
  threadRootId: number | null
  onOpenThread: (rootId: number) => void
  /** R14-P0.5 — opens the run-detail sheet in place of a navigation. See
   * `MessageRow`'s own `onOpenRun` for why this only fires for an EXACT
   * run link. */
  onOpenRun: (runId: number) => void
  /**
   * What a send produced: the row, and the two lists that used to be dropped
   * on the floor.
   *
   * This replaced a plain `onPosted(message)`. `postChannelMessageAction` has
   * always returned `dispatched` and `mentionsSkipped` alongside the message
   * and NOTHING consumed either, which is exactly how mentioning an agent
   * could start a real run and still leave the channel looking inert.
   */
  onDispatched: (input: {
    message: RoomFeedMessage
    dispatched: Array<{ slotId: number; displayName: string; runId: number }>
    skipped: Array<{ slotId: number; displayName: string; reason: string }>
  }) => void
  /** R12-P3.1 - paint the message now, reconcile when the server answers. */
  onOptimisticInsert: (row: RoomFeedMessage) => void
  onOptimisticSettle: (pendingKey: string, real: RoomFeedMessage | null, failure?: string) => void
  /** Removes a failed row and hands its text back, so a refused send never
   * costs somebody what they wrote. */
  onOptimisticDiscard: (pendingKey: string) => string | null
  onPatchMessage: (id: number, patch: Partial<RoomFeedMessage>) => void
  onDismissPending: (runId: number) => void
  onOpenTask: (taskId: number) => void
  /** Resolves to an error string, or null when the task was created. */
  onMakeTask: (messageId: number) => Promise<string | null>
  onCommand: SlashCommandRunner
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

  const [focusedId, setFocusedId] = useState<number | null>(null)
  const [composerFocusToken, setComposerFocusToken] = useState(0)
  /** The newest id present on the very first paint. Everything after it is an
   * arrival this session, and therefore something the frozen server count
   * cannot already include. */
  const openHighWaterRef = useRef<number | null>(null)
  /** The newest id at the moment the catch-up strip was taken, or null while
   * it is still outstanding. Everything at or below it has been accounted for.
   * Kept as an id rather than a boolean so a mention arriving AFTER the jump
   * still brings the strip back — being told about a new mention is the one
   * thing the strip must never stop doing. */
  const [takenFrom, setTakenFrom] = useState<number | null>(null)

  const visible = useMemo(() => (feed.length > cap ? feed.slice(-cap) : feed), [feed, cap])
  const hidden = feed.length - visible.length
  const lastId = feed.length > 0 ? feed[feed.length - 1].id : 0
  if (openHighWaterRef.current === null) openHighWaterRef.current = lastId

  /** Ghosts and skip notes, bucketed by the message they belong under. Built
   * once per render rather than filtered inside the row loop, which would be
   * a scan of both arrays per message. */
  const pendingByMessage = useMemo(() => {
    const map = new Map<number, PendingReply[]>()
    for (const row of pending) {
      const bucket = map.get(row.messageId)
      if (bucket) bucket.push(row)
      else map.set(row.messageId, [row])
    }
    return map
  }, [pending])

  /** Keyed by the feed row the block belongs under. Two members can be blocked
   * under one root, so this is a list per id like the ghost rows are. */
  const approvalsByRoot = useMemo(() => {
    const map = new Map<number, ChannelApproval[]>()
    for (const row of approvals) {
      const bucket = map.get(row.rootMessageId)
      if (bucket) bucket.push(row)
      else map.set(row.rootMessageId, [row])
    }
    return map
  }, [approvals])

  const skippedByMessage = useMemo(() => {
    const map = new Map<number, SkippedMention[]>()
    for (const row of skipped) {
      const bucket = map.get(row.messageId)
      if (bucket) bucket.push(row)
      else map.set(row.messageId, [row])
    }
    return map
  }, [skipped])

  /**
   * The catch-up numbers.
   *
   * The server's own count at open (`listChannelUnread`, which computes unread
   * and mentions in ONE grouped query and keeps them separate) plus whatever
   * has arrived since. Split, not summed: "12 new" is a reason to scroll and
   * "2 mentions" is a reason to stop, and one badge cannot say both.
   */
  const { unreadCount, mentionCount } = useMemo(() => {
    // Once the strip has been TAKEN, the backlog behind it is spent: counting
    // restarts from the newest message at that moment and the frozen server
    // numbers stop contributing. Without this the strip was permanent — both
    // of its inputs only ever grow — so a reader who had jumped, read
    // everything and come back to the bottom still had "12 new messages"
    // pinned to the top of the channel for the rest of the session. A count
    // that is wrong in the safe direction is still a count people learn to
    // ignore, and the strip's whole value is being believed.
    const since = takenFrom ?? openHighWaterRef.current ?? 0
    let extra = 0
    let extraMentions = 0
    for (const message of feed) {
      if (message.id <= since) continue
      if (message.fromSlotId === mySlotId) continue
      extra += 1
      if (mySlotId != null && message.mentions.some((m) => m.type === 'slot' && m.id === mySlotId)) {
        extraMentions += 1
      }
    }
    const base = takenFrom == null ? { unread: unreadAtOpen, mentions: mentionsAtOpen } : { unread: 0, mentions: 0 }
    return { unreadCount: base.unread + extra, mentionCount: base.mentions + extraMentions }
  }, [feed, mySlotId, unreadAtOpen, mentionsAtOpen, takenFrom])

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
        const { added, actorSlotId } = unwrap(
          await toggleReactionAction({ workspaceId, teamId, messageId, emoji }),
        )
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

  /**
   * Make-a-task, in one place.
   *
   * Shared by the hover button and the `e` shortcut so the two can never
   * diverge into two behaviours for one action. The failure is surfaced as a
   * toast rather than swallowed: creating a task is a write, and a write that
   * silently does nothing is the bug this whole unit is about.
   */
  const runMakeTask = useCallback(
    async (messageId: number) => {
      const failure = await onMakeTask(messageId).catch((error: unknown) =>
        error instanceof Error ? error.message : 'Something went wrong.',
      )
      if (failure) toast({ title: 'Task not created', description: failure, variant: 'destructive' })
    },
    [onMakeTask],
  )

  /**
   * Scrolls the frozen "New" divider back into view.
   *
   * The divider is the answer to "where did I leave off"; the catch-up strip
   * is just a way to find it again after scrolling past.
   *
   * There is one case with a real count and no divider: a member who has never
   * read the channel at all has `last_read_message_id` NULL, which
   * `listChannelUnread` reads through `COALESCE(..., 0)` — so every message is
   * unread to them — while `firstUnreadId` requires a boundary and finds none.
   * Rather than either hide the count or move the divider to the top of the
   * conversation (which would make a first visit look like an unread backlog),
   * the strip still shows and this scrolls to the oldest message loaded.
   */
  const jumpToDivider = useCallback(() => {
    const el = dividerRef.current ?? scrollerRef.current?.firstElementChild
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    // Taken. The divider itself stays exactly where it is — that is the
    // "where did I leave off" marker and it is frozen for the whole visit;
    // this only retires the strip that pointed at it.
    setTakenFrom(lastId)
    pinnedToBottom.current = false
    setAtBottom(false)
  }, [lastId])

  /**
   * KEYBOARD-FIRST (item 8).
   *
   * Registered in the `'channel'` scope, not `'global'`: `j`/`k` are already
   * bound in the Inbox's `'list'` scope and in the task list, and a bare
   * letter that fires from anywhere in the app is a trap. The registry
   * ref-counts scope activation, so these bindings exist only while this
   * component is mounted — which is also only while the Channel tab is the
   * one on screen.
   *
   * Typing is never intercepted: `components/keyboard/keyboard-provider.tsx`
   * drops every combo except Escape when the event target is an input, a
   * textarea, a select or anything contenteditable, so none of these can fire
   * from inside the composer.
   */
  const moveFocus = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const currentIndex = focusedId == null ? -1 : visible.findIndex((m) => m.id === focusedId)
      // From nowhere, `j` starts at the newest message and `k` at the oldest
      // on screen — the row nearest the direction of travel, rather than an
      // arbitrary end that makes the first keypress feel like a jump.
      const nextIndex =
        currentIndex === -1
          ? delta > 0
            ? visible.length - 1
            : 0
          : Math.min(visible.length - 1, Math.max(0, currentIndex + delta))
      const next = visible[nextIndex]
      if (!next) return
      setFocusedId(next.id)
      document.getElementById(`team-message-${next.id}`)?.scrollIntoView({ block: 'nearest' })
      // Moving the cursor off the bottom must stop the feed dragging you back
      // down when the next message lands.
      pinnedToBottom.current = nextIndex === visible.length - 1
    },
    [visible, focusedId],
  )

  const focused = useMemo(
    () => (focusedId == null ? null : (visible.find((m) => m.id === focusedId) ?? null)),
    [visible, focusedId],
  )

  useKeyboardShortcut('j', 'Next message', () => moveFocus(1), 'channel')
  useKeyboardShortcut('k', 'Previous message', () => moveFocus(-1), 'channel')
  useKeyboardShortcut('t', 'Open the focused message’s thread', () => {
    if (focused) onOpenThread(focused.id)
  }, 'channel')
  useKeyboardShortcut(
    'r',
    'Reply to the focused message',
    () => {
      // Reply IS the thread pane: its composer takes focus on mount
      // (`autoFocus`), so opening it is the whole action. A separate inline
      // reply box would be the second composer this unit is told not to add.
      if (focused) onOpenThread(focused.id)
    },
    'channel',
  )
  useKeyboardShortcut(
    'e',
    'Make a task from the focused message',
    () => {
      if (!focused || focused.systemKind != null || focused.taskId != null) return
      void runMakeTask(focused.id)
    },
    'channel',
  )
  useKeyboardShortcut('/', 'Write a message', () => setComposerFocusToken((t) => t + 1), 'channel')

  const send = useCallback(
    async (input: { body: string; kind: TeamMessageKind; toSlotId: number | null; attachments: number[] }) => {
      // THE PAINT COMES FIRST. D0 names this path specifically: "No round trip
      // on the send path. Pressing Enter paints immediately." Until now this
      // awaited the insert before the row existed anywhere on screen, which on
      // a warm local database looked fine and over a real network is the
      // difference between chat and a form.
      //
      // Mentions are parsed here as well as on the server. Not duplication for
      // its own sake: the highlight on `@Claude Code` has to be in the row the
      // instant it appears, and the server's own parse remains the one that
      // decides who is actually woken.
      const optimistic = makeOptimisticMessage({
        teamId,
        fromSlotId: mySlotId,
        toSlotId: input.toSlotId,
        kind: input.kind,
        body: input.body,
        threadRootId: null,
        mentions: parseMentionsLocally(input.body, slots),
        attachments: input.attachments,
      })
      onOptimisticInsert(optimistic)
      pinnedToBottom.current = true
      setAtBottom(true)

      try {
        const result = unwrap(
          await postChannelMessageAction({
            workspaceId,
            teamId,
            body: input.body,
            kind: input.kind,
            toSlotId: input.toSlotId,
            threadRootId: null,
            attachments: input.attachments,
          }),
        )
        onOptimisticSettle(optimistic.pendingKey!, { ...result.message, systemKind: null, undeliverableAt: null, addresseeMissing: false })
        // Appended from the returned row rather than refetching the channel:
        // the insert already told us exactly what landed, and re-reading the
        // room to show a message we are holding is the round trip D0 forbids.
        //
        // `dispatched` and `mentionsSkipped` come back on the SAME response,
        // and both were previously thrown away — which is precisely how
        // mentioning an agent could start a real run and still look, on
        // screen, like nothing at all had happened.
        onDispatched({
          message: result.message,
          dispatched: result.dispatched ?? [],
          skipped: result.mentionsSkipped ?? [],
        })
      } catch (error) {
        // The row stays, marked failed, rather than vanishing with a toast.
        // A toast is gone in four seconds and takes the text with it; a failed
        // row keeps what was written and offers to send it again.
        onOptimisticSettle(
          optimistic.pendingKey!,
          null,
          error instanceof Error ? error.message : 'That message was not sent.',
        )
      }
    },
    [workspaceId, teamId, onDispatched, onOptimisticInsert, onOptimisticSettle, mySlotId, slots],
  )

  /** Send it again. The failed row is removed and a fresh one takes its place,
   * so a second failure reads as one attempt rather than as a pile. */
  const retrySend = useCallback(
    (pendingKey: string) => {
      const body = onOptimisticDiscard(pendingKey)
      // Attachments are not retried — `onOptimisticDiscard` only ever
      // returned the body text, and re-plumbing it to also hand back the
      // discarded row's attachment ids is a bigger change to
      // `channel-view.tsx`'s own optimistic-message bookkeeping than this
      // unit's file-ownership boundary allows for this phase. A rare edge
      // case (retry-after-failure on a message that also had a file) loses
      // the attachment and keeps the text, which is the same "text survives,
      // nothing else does" contract this retry already had before today.
      if (body) void send({ body, kind: 'status', toSlotId: null, attachments: [] })
    },
    [onOptimisticDiscard, send],
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
        THE CATCH-UP STRIP (item 6).

        Only when there is something to catch up on, and it disappears for
        good once the reader has taken it - a permanent bar saying "0 new" is
        a strip of chrome that teaches people to stop reading the top of the
        page. The mention count is separate and louder than the unread count
        because the two mean different things: one is a reason to scroll, the
        other is a reason to stop what you are doing.
      */}
      {(unreadCount > 0 || mentionCount > 0) && (
        <button
          type="button"
          onClick={jumpToDivider}
          className="flex shrink-0 items-center gap-2 border-b border-black/10 bg-black/[.03] px-3 py-1.5 text-left text-xs hover:bg-black/[.05] dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.08]"
        >
          <span className="font-medium">
            {unreadCount} new {unreadCount === 1 ? 'message' : 'messages'}
          </span>
          {mentionCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px font-medium text-amber-700 dark:text-amber-300">
              <AtSign size={10} />
              {mentionCount} {mentionCount === 1 ? 'mention' : 'mentions'}
            </span>
          )}
          <span className="ml-auto text-black/45 dark:text-white/45">Jump to where you left off</span>
        </button>
      )}

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
            const runLink = runLinkFor(message, runs, slots)
            const rowPending = pendingByMessage.get(message.id)
            const rowSkipped = skippedByMessage.get(message.id)
            const rowApprovals = approvalsByRoot.get(message.id)
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
                  taskChip={taskChipFor(tasks, slots, message.taskId)}
                  runSessionId={runLink?.sessionId ?? null}
                  runIsExact={runLink?.exact ?? false}
                  runId={runLink?.runId}
                  onOpenRun={onOpenRun}
                  workspaceSlug={workspaceSlug}
                  focused={focusedId === message.id}
                  threadOpen={threadRootId === message.id}
                  onOpenThread={onOpenThread}
                  onOpenTask={onOpenTask}
                  onMakeTask={
                    // A row that has not been written yet has no id the server
                    // could act on, so it offers no id-addressed action at all.
                    message.systemKind != null || message.taskId != null || isOptimistic(message)
                      ? null
                      : (id) => void runMakeTask(id)
                  }
                  onRetrySend={retrySend}
                  onDiscardSend={(key) => void onOptimisticDiscard(key)}
                  onToggleReaction={(id, emoji) => void toggleReaction(id, emoji)}
                  busy={false}
                />

                {/* A mention that woke nobody, said out loud. This is the
                    other half of the silence bug: the server already knew
                    "Bob is a person, not an agent" and nothing printed it. */}
                {rowSkipped?.map((note) => (
                  <li
                    key={`skip-${note.slotId}-${note.messageId}`}
                    className="ml-11 mt-0.5 flex items-start gap-1.5 px-2 text-[11px] text-black/45 dark:text-white/45"
                  >
                    <span aria-hidden className="mt-1 size-1 shrink-0 rounded-full bg-black/25 dark:bg-white/30" />
                    <span>
                      <span className="font-medium">{note.displayName}</span> was not started - {note.reason}.
                    </span>
                  </li>
                ))}

                {/* A blocked agent, decidable without leaving the channel.
                    Above the ghost rows on purpose: the block is why the ghost
                    below it has stopped moving. */}
                {rowApprovals?.map((row) => {
                  const slot = slotById(slots, row.slotId)
                  // A parked connection wears the same row as a parked
                  // permission and differs only in what it asks of the reader.
                  const Strip = isConnectRequest(row.externalId) ? ConnectStrip : ApprovalStrip
                  return (
                    <li key={`approval-${row.externalId}`} className="ml-9 px-1.5">
                      <Strip
                        approval={row}
                        slotName={slot?.displayName ?? null}
                        canDecide={row.requestedUserId === currentUserId}
                        holderName={
                          slots.find((s) => s.userId === row.requestedUserId)?.displayName ?? null
                        }
                        onSettled={onApprovalSettled}
                        onOpenRun={onOpenRun}
                      />
                    </li>
                  )
                })}

                {/* The ghost rows. One per woken agent, each streaming its own
                    run straight into the feed. */}
                {rowPending?.map((row) => (
                  <PendingReplyRow
                    key={row.runId}
                    workspaceId={workspaceId}
                    teamId={teamId}
                    pending={row}
                    slots={slots}
                    onDismiss={onDismissPending}
                    onOpenRun={onOpenRun}
                  />
                ))}
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
        {/* R12-P3.2 — one row per typer, above the composer, siblings of the
            ghost rows an agent gets in the feed. Rendered from `slots` the
            room already has in memory, so this costs nothing beyond the SSE
            frame that put the id in `typingSlotIds`. */}
        {typingSlotIds.length > 0 && (
          <ul>
            {typingSlotIds.map((slotId) => (
              <TypingIndicatorRow key={slotId} slotId={slotId} slots={slots} />
            ))}
          </ul>
        )}
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
          workspaceId={workspaceId}
          slots={slots}
          placeholder="Message the channel… (@ to mention, / for commands)"
          showKind
          showRecipient
          onSend={send}
          onTyping={onTyping}
          onCommand={onCommand}
          focusToken={composerFocusToken}
        />
        {/* This paragraph used to say "nothing dispatches a run from here
            yet", which stopped being true when `lib/teams/mention-dispatch.ts`
            landed. A footnote that contradicts the ghost row directly above it
            is worse than no footnote at all. */}
        <p className={cn('px-3 pb-2 text-[11px] text-black/35 dark:text-white/35')}>
          Written to the team mailbox. Naming an agent with <span className="font-medium">@</span> starts its turn
          straight away and its answer streams in under your message; everyone else picks the message up through the
          team MCP surface (R6.2).
        </p>
      </div>
    </div>
  )
}
