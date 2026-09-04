'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, Hash, Loader2, Lock, MessageSquare, Network, NotebookPen, OctagonX } from 'lucide-react'
import type { ChannelApproval, TeamTask } from '@/lib/broker'
import type { TeamRoomMessage, TeamSlotHealth, TeamStopState } from '@/lib/teams/reliability'
import { unwrap } from '@/lib/failures'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { formatRelativeTime } from '@/lib/relative-time'
import {
  clearTeamStopAction,
  createTaskFromMessageAction,
  createTeamTaskAction,
  joinChannelAction,
  loadChannelRunSnapshotAction,
  loadChannelRunsAction,
  loadThreadAction,
  markChannelReadAction,
  notifyTypingAction,
  pollTeamRoomAction,
  stopTeamRoomAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import type { Channel } from '@/app/(app)/workspace/[workspaceSlug]/teams/data'
import {
  SLOT_STATE_LABEL,
  formatSilence,
  isTerminalRunStatus,
  subjectFromBody,
  type ChannelRunLink,
  type PendingReply,
  type RoomFeedMessage,
  type SkippedMention,
  type TeamAgentOption,
  type TeamSlotView,
  type TeamUserOption,
} from './shared'
import { ChannelView } from './channel-view'
import { ThreadPane } from './thread-pane'
import { CanvasPane } from './canvas-pane'
import { LanesView } from './lanes-view'
import { BoardView } from './board-view'
import { RosterPanel } from './roster-panel'
import { RunDetailSheet } from '@/components/runs/run-detail-sheet'

type RoomView = 'channel' | 'lanes' | 'board'

const VIEWS: Array<{ id: RoomView; label: string; icon: typeof MessageSquare }> = [
  { id: 'channel', label: 'Channel', icon: MessageSquare },
  { id: 'lanes', label: 'Lanes', icon: Columns3 },
  { id: 'board', label: 'Board', icon: Network },
]

/**
 * R12-P3.3 — the push channel D0's own header called "the real fix" now
 * exists (`/api/teams/[teamId]/events/stream`), so this stopped being the
 * room's clock and became its reconciliation sweep: the interval that
 * catches whatever a missed `NOTIFY` — a dropped LISTEN, or a notification
 * that arrived mid-reconnect (`lib/broker/notify.ts` documents both) —
 * would otherwise leave stale. Sixty seconds, not six: the fast path is the
 * SSE `refresh` event driving `pollNowRef` below, and this is only the net
 * under it.
 */
const POLL_MS = 60_000

/** R12-P3.2 — how long a typing signal is trusted with nobody renewing it.
 * The composer throttles its OWN publishes to one per two seconds while
 * there is uncommitted text (`message-composer.tsx`), so four seconds is
 * "missed at most one renewal, not stuck forever" — long enough to survive
 * one dropped `NOTIFY` in a row, short enough that closing the tab or
 * clearing the box reads as "stopped typing" within a breath rather than a
 * ghost that lingers after the person left. */
const TYPING_TTL_MS = 4_000

/**
 * How many polls in a row have to fail before the room says so.
 *
 * R12-P1.5. Three, not one: a single missed tick is a hiccup — a laptop lid, a
 * dev server restarting, one dropped request — and a strip that flashed for
 * every one of those would be the thing people learn to ignore. Three
 * consecutive failures is eighteen seconds of silence, long enough to mean the
 * room really has stopped hearing from the server and short enough to say so
 * before anybody concludes the channel is simply quiet.
 */
const POLLS_BEFORE_RECONNECTING = 3

/**
 * How many recent roots each poll re-reads.
 *
 * A reaction and a reply do not create a new root, so an append-only cursor
 * would never notice either arriving on a message already on screen. The
 * client therefore asks for a bounded WINDOW of its newest roots to be
 * refreshed as well as for anything after them — bounded so the payload of an
 * idle room stays a few dozen small rows rather than the whole conversation.
 */
const FEED_REFRESH_WINDOW = 40

/**
 * The room: one set of data, three views over it, and two optional panes.
 *
 * All three views read the SAME arrays held here, so switching view is a
 * render and never a fetch. That is also why view state is local rather than a
 * route segment the server reads: a round trip to change tab is the exact
 * latency D0 rules out. The choice is still mirrored into the URL with
 * `history.replaceState` so a reload or a shared link lands on the same view
 * without Next re-rendering the page.
 *
 * The CHANNEL is the default, because a channel is what this is.
 */
export function TeamRoom({
  workspaceId,
  workspaceSlug,
  channel,
  currentUserId,
  slots: initialSlots,
  initialFeed,
  initialMessages,
  initialTasks,
  initialClaimableIds,
  initialHealth,
  initialStop,
  initialRuns,
  initialApprovals,
  initialUnread,
  agents,
  users,
}: {
  workspaceId: number
  workspaceSlug: string
  channel: Channel
  currentUserId: number
  slots: TeamSlotView[]
  initialFeed: RoomFeedMessage[]
  initialMessages: TeamRoomMessage[]
  initialTasks: TeamTask[]
  initialClaimableIds: number[]
  initialHealth: TeamSlotHealth[]
  initialStop: TeamStopState
  /**
   * messageId -> the run that message started, for the whole first page, from
   * ONE query (`getRunsForChannelMessages`). Resolved on the server so the
   * "See full run" links and any in-flight ghost rows are correct on FIRST
   * PAINT — a reload in the middle of an agent's turn used to show a channel
   * with nothing happening in it.
   */
  initialRuns: Record<number, { runId: number; sessionId: number | null; status: string }>
  /**
   * Permission requests already blocking a run when the page was rendered.
   *
   * Server-resolved so a reload in the middle of a block paints the button
   * immediately rather than six seconds later on the first poll.
   */
  initialApprovals: ChannelApproval[]
  /** The server's own unread/mention counts at open (`listChannelUnread`). */
  initialUnread: { unreadCount: number; mentionCount: number }
  agents: TeamAgentOption[]
  users: TeamUserOption[]
}) {
  const [view, setView] = useState<RoomView>('channel')
  const [slots, setSlots] = useState(initialSlots)
  const [feed, setFeed] = useState(initialFeed)
  const [messages, setMessages] = useState(initialMessages)
  const [tasks, setTasks] = useState(initialTasks)
  const [claimableIds, setClaimableIds] = useState(initialClaimableIds)
  const [health, setHealth] = useState(initialHealth)
  const [stop, setStop] = useState(initialStop)
  const [stopping, setStopping] = useState(false)
  /** Consecutive failed polls. See `POLLS_BEFORE_RECONNECTING`. */
  const [pollFailures, setPollFailures] = useState(0)
  const [joining, setJoining] = useState(false)
  const [threadRootId, setThreadRootId] = useState<number | null>(null)
  const [thread, setThread] = useState<RoomFeedMessage[]>([])
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [runs, setRuns] = useState<Map<number, ChannelRunLink>>(
    () => new Map(Object.entries(initialRuns).map(([id, link]) => [Number(id), link])),
  )
  /**
   * Blocked runs, refreshed by the poll that was already running.
   *
   * Unlike `runs`, this is NOT ask-once: a run gains an approval in the middle
   * of its turn and loses it when somebody decides, so it is live state and
   * rides the room's existing tick. It costs no extra request — see
   * `listPendingChannelApprovals`.
   */
  const [approvals, setApprovals] = useState<ChannelApproval[]>(initialApprovals)
  /** R12-P3.2 — slotId → the timestamp its last typing signal arrived at.
   * A `Map`, not a `Set`, because expiring one signal without disturbing the
   * others needs to know WHEN each one arrived, not just that it did. */
  const [typingSlotIds, setTypingSlotIds] = useState<Map<number, number>>(() => new Map())
  const [pending, setPending] = useState<PendingReply[]>([])
  const [skipped, setSkipped] = useState<SkippedMention[]>([])
  /**
   * Runs whose ghost row is finished with, for either reason: the answer
   * landed, or a person waved it away.
   *
   * This set is what stops the row coming straight back. `runs` still holds
   * the run at whatever status it had when we last asked — and we deliberately
   * never re-ask, because status is not what retires a ghost — so without a
   * memory here the hydration effect below would re-add every retired row on
   * its next pass, with a fresh baseline that could never retire again.
   */
  const [retiredRunIds, setRetiredRunIds] = useState<Set<number>>(() => new Set())
  /** The board card to scroll to and flash, set by a task chip in the feed. */
  const [focusTaskId, setFocusTaskId] = useState<number | null>(null)
  /** R14-P0.5 — the run-detail sheet's own state, owned here rather than by
   * whichever row opened it: the sheet outlives the row that triggered it
   * (a ghost row can finish and unmount while its sheet is still open), and
   * there is exactly one sheet per room regardless of how many rows can open
   * one. */
  const [sheetRunId, setSheetRunId] = useState<number | null>(null)
  const openRunSheet = useCallback((runId: number) => setSheetRunId(runId), [])
  // Same authorization boundary as every other run-reader in this room: the
  // channel-scoped action, which checks the run's message belongs to this
  // team. No new "any run" loader — that would widen what the sheet can read
  // beyond what the row that opened it was ever allowed to see.
  const loadRunSnapshot = useCallback(
    async (runId: number) => unwrap(await loadChannelRunSnapshotAction({ workspaceId, teamId: channel.id, runId })),
    [workspaceId, channel.id],
  )
  // The Work page is keyed by session, not run — `runs` (keyed by message id)
  // is the only place this component already has that mapping, so the sheet's
  // "Open in Work" link is found the same way `runLinkFor` finds it for the
  // feed rows themselves, rather than adding a second lookup path.
  const sheetSessionId = useMemo(() => {
    if (sheetRunId == null) return null
    for (const link of runs.values()) {
      if (link.runId === sheetRunId) return link.sessionId
    }
    return null
  }, [sheetRunId, runs])

  // The server re-renders this component with fresh props after any action
  // that calls revalidatePath (adding a slot, changing the leader). Without
  // this the roster would show stale rows after a refresh.
  useEffect(() => setSlots(initialSlots), [initialSlots])

  // LOWEST id, not the first row, because `loadSlots` sorts the leader to the
  // top while the server's `resolveMySlot` is `ORDER BY id LIMIT 1`. Nothing
  // stops the database holding two slots for one person (the 0013 CHECK is
  // agent-XOR-user, not one-slot-per-person; only the pickers refuse it), and
  // if that ever happens the client must pick the same row the server writes
  // reactions and the read cursor against — otherwise "you reacted" and the
  // unread divider would both be reading somebody else's slot.
  const mySlot = useMemo(
    () => slots.filter((s) => s.userId === currentUserId).reduce<TeamSlotView | null>((lowest, s) => (lowest && lowest.id < s.id ? lowest : s), null),
    [slots, currentUserId],
  )
  const mySlotId = mySlot?.id ?? null

  /**
   * Where the "new messages" line goes, frozen at open.
   *
   * Read once, from the cursor as it stood on the first paint. It deliberately
   * does not follow `mySlot.lastReadMessageId`: marking the feed read moves
   * that forward within a second of arriving, and a live boundary would erase
   * the divider at exactly the moment somebody is looking for where they left
   * off.
   */
  const unreadBoundaryRef = useRef<number | null>(
    initialSlots
      .filter((s) => s.userId === currentUserId)
      .reduce<TeamSlotView | null>((lowest, s) => (lowest && lowest.id < s.id ? lowest : s), null)
      ?.lastReadMessageId ?? null,
  )

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view')
    if (requested === 'lanes' || requested === 'board' || requested === 'channel') setView(requested)
  }, [])

  const selectView = useCallback((next: RoomView) => {
    setView(next)
    const url = new URL(window.location.href)
    url.searchParams.set('view', next)
    // replaceState, not router.replace: this must not re-run the server
    // component. The view is a client concern; the URL is only a bookmark.
    window.history.replaceState(null, '', url)
  }, [])

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : 0
  const lastMessageIdRef = useRef(lastMessageId)
  lastMessageIdRef.current = lastMessageId

  const feedSince = useMemo(() => {
    if (feed.length === 0) return 0
    const first = feed[Math.max(0, feed.length - FEED_REFRESH_WINDOW)]
    // Minus one, because `listChannelFeed` is `id > since` and the window has
    // to include the row it starts at.
    return Math.max(0, first.id - 1)
  }, [feed])
  const feedSinceRef = useRef(feedSince)
  feedSinceRef.current = feedSince
  const threadRootIdRef = useRef(threadRootId)
  threadRootIdRef.current = threadRootId

  /** Appends only rows we do not already hold. The poll and an optimistic send
   * can both deliver the same message — the send returns the inserted row, and
   * the next poll reads forward from a cursor that may predate it. */
  const mergeMessages = useCallback((incoming: TeamRoomMessage[]) => {
    if (incoming.length === 0) return
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      const fresh = incoming.filter((m) => !seen.has(m.id))
      if (fresh.length === 0) return prev
      return [...prev, ...fresh].sort((a, b) => a.id - b.id)
    })
  }, [])

  /** REPLACES by id and appends the rest. A refreshed root carries new
   * reaction and reply counts, so keeping the row we already had would be the
   * whole point of the refresh window thrown away. */
  const mergeFeed = useCallback((incoming: RoomFeedMessage[]) => {
    if (incoming.length === 0) return
    setFeed((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]))
      for (const message of incoming) byId.set(message.id, message)
      return [...byId.values()].sort((a, b) => a.id - b.id)
    })
  }, [])

  /**
   * R12-P3.1 - a message appears the instant it is typed.
   *
   * Inserted straight into whichever list it belongs in, with no server call
   * between the keystroke and the paint. `settleOptimistic` below swaps it for
   * the row the database actually wrote, matched on `pendingKey` because the
   * placeholder has no real id yet.
   */
  const insertOptimistic = useCallback((row: RoomFeedMessage) => {
    if (row.threadRootId == null) {
      setFeed((prev) => [...prev, row])
      return
    }
    setThread((prev) => (prev.length === 0 ? prev : [...prev, row]))
    // The root's reply count is nudged here for the same reason `appendReply`
    // nudges it: the count is computed server-side and the next refresh will
    // correct it, but leaving it stale for six seconds makes a reply you can
    // see on screen look like it did not happen.
    setFeed((prev) =>
      prev.map((m) =>
        m.id === row.threadRootId ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: row.createdAt } : m,
      ),
    )
  }, [])

  /**
   * The placeholder becomes the real row, or becomes a failure.
   *
   * On success the swap is by identity rather than by append-and-dedupe: the
   * placeholder and the real row are the same message with two different ids,
   * so anything that merely added the real one would leave the channel showing
   * it twice until a refresh.
   */
  const settleOptimistic = useCallback((pendingKey: string, real: RoomFeedMessage | null, failure?: string) => {
    const swap = (prev: RoomFeedMessage[]) => {
      const index = prev.findIndex((m) => m.pendingKey === pendingKey)
      if (index === -1) return prev
      const next = [...prev]
      if (real) next[index] = real
      else next[index] = { ...next[index], sendState: 'failed', failureMessage: failure }
      return real ? next.sort((a, b) => a.id - b.id) : next
    }
    setFeed(swap)
    setThread(swap)
  }, [])

  /** Take a failed message off the screen. The text is handed back to the
   * caller so it can be put in the composer - a send that failed must never
   * cost somebody what they wrote. */
  const discardOptimistic = useCallback((pendingKey: string): string | null => {
    let body: string | null = null
    const drop = (prev: RoomFeedMessage[]) => {
      const found = prev.find((m) => m.pendingKey === pendingKey)
      if (!found) return prev
      body = found.body
      return prev.filter((m) => m.pendingKey !== pendingKey)
    }
    setFeed(drop)
    setThread(drop)
    return body
  }, [])

  const patchMessage = useCallback((id: number, patch: Partial<RoomFeedMessage>) => {
    setFeed((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
    setThread((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }, [])

  /**
   * Poll now, for the header's Retry.
   *
   * Held in a ref rather than lifted out of the effect: `tick` closes over that
   * effect's own `cancelled` and `inFlight` flags, and a second copy outside
   * would be a second poller the in-flight guard cannot see.
   */
  const pollNowRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      // A backgrounded tab polling a room nobody is looking at is pure waste,
      // and the in-flight guard stops a slow tick from stacking requests on a
      // busy room.
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        const delta = unwrap(
          await pollTeamRoomAction({
            workspaceId,
            teamId: channel.id,
            sinceMessageId: lastMessageIdRef.current,
            feedSince: feedSinceRef.current,
            threadRootId: threadRootIdRef.current,
          }),
        )
        if (cancelled) return
        mergeMessages(delta.messages)
        mergeFeed(delta.feed)
        if (delta.thread) setThread(delta.thread)
        setTasks(delta.tasks)
        setClaimableIds(delta.claimableIds)
        setHealth(delta.health)
        setStop(delta.stop)
        setApprovals(delta.approvals)
        // Cleared on the FIRST success, so the strip below states something
        // about the connection now rather than tallying everything that has
        // ever failed in this room.
        setPollFailures((n) => (n === 0 ? n : 0))
      } catch {
        // Still not a toast — one every six seconds would be worse than the bug
        // it reports, which is why this was a bare swallow. Counted instead
        // (R12-P1.5), so a room that has genuinely stopped hearing from the
        // server says so once, quietly, in its header: until this, a dead poll
        // and a quiet channel looked exactly the same.
        if (!cancelled) setPollFailures((n) => n + 1)
      } finally {
        inFlight = false
      }
    }
    pollNowRef.current = () => void tick()
    const handle = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      pollNowRef.current = null
      window.clearInterval(handle)
    }
  }, [workspaceId, channel.id, mergeMessages, mergeFeed])

  /**
   * R12-P3.3 — the push connection. One `EventSource` per open room, wired
   * to the SAME `pollNowRef` the header's manual Retry button already uses:
   * a `refresh` frame is not new data, it is "ask for new data NOW instead of
   * on your next sixty-second tick", so this reuses the tested read path
   * (`pollTeamRoomAction`) rather than teaching the client a second way to
   * receive a room delta.
   *
   * `EventSource` auto-reconnects on its own with backoff, which is exactly
   * P3's "Done when": a 30-second network pull produces a state that
   * self-heals with no lost messages, because the room's data never actually
   * depended on this connection staying up — the 60s sweep above is still
   * running underneath it the whole time.
   */
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let cancelled = false
    let source: EventSource | null = null

    const connect = () => {
      if (cancelled) return
      source = new EventSource(`/api/teams/${channel.id}/events/stream`)

      source.addEventListener('refresh', () => pollNowRef.current?.())

      source.addEventListener('typing', (event) => {
        try {
          const { slotId } = JSON.parse((event as MessageEvent).data) as { slotId?: number }
          if (typeof slotId !== 'number') return
          setTypingSlotIds((prev) => {
            const next = new Map(prev)
            next.set(slotId, Date.now())
            return next
          })
        } catch {
          // A malformed typing frame is cosmetic — the indicator just does
          // not appear for this one signal.
        }
      })

      // The browser's own `EventSource` retries on `error` with its default
      // backoff; nothing here forces a reconnect. What IS added is the
      // catch-up: the moment the connection is healthy again, ask for a
      // fresh delta rather than trusting that nothing changed while it was
      // down — the server sends its own `refresh` on every new connect
      // (see the route's own comment), but `onopen` covers the resume case
      // too, at zero extra cost.
      source.onopen = () => pollNowRef.current?.()
    }

    connect()
    return () => {
      cancelled = true
      source?.close()
    }
  }, [channel.id])

  /** R12-P3.2 — expired typing signals fall off on a timer rather than on
   * next render: nobody re-renders this component just because four seconds
   * passed, so without a timer a typing dot could sit frozen on screen long
   * after the two-second republish stopped arriving. Runs only while there is
   * at least one entry to expire. */
  useEffect(() => {
    if (typingSlotIds.size === 0) return
    const handle = window.setInterval(() => {
      const cutoff = Date.now() - TYPING_TTL_MS
      setTypingSlotIds((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [slotId, at] of prev) {
          if (at < cutoff) {
            next.delete(slotId)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => window.clearInterval(handle)
  }, [typingSlotIds.size])

  /** Published on every keystroke the composer throttles down to one per two
   * seconds — see `MessageComposer`'s own `onTyping` prop. Best-effort by
   * construction: `notifyTypingAction` swallows everything itself, so there
   * is nothing here to catch. */
  const notifyTyping = useCallback(() => {
    void notifyTypingAction({ workspaceId, teamId: channel.id })
  }, [workspaceId, channel.id])

  /** Who is typing, minus me — announcing your own keystrokes back to
   * yourself is not a feature. Derived rather than filtered at publish time,
   * because the SSE frame's `slotId` is the ONLY honest source for "someone
   * else is typing" and the room already knows its own slot. */
  const typingSlotIdsOthers = useMemo(
    () => [...typingSlotIds.keys()].filter((id) => id !== mySlotId),
    [typingSlotIds, mySlotId],
  )

  /**
   * Marking read, once per new high-water mark.
   *
   * `ChannelView` decides WHEN the feed has been seen — visible tab, channel
   * view mounted, bottom of the list in the viewport. This only makes sure the
   * same id is not written on every intersection callback: `markChannelRead`
   * is a `GREATEST` update, so a repeat is harmless, but it is still a request
   * per scroll event.
   */
  const markedRef = useRef(0)
  const onSeen = useCallback(
    (messageId: number) => {
      if (messageId <= markedRef.current) return
      markedRef.current = messageId
      // `.then(unwrap)` so the swallow stays reachable: a refusal now arrives
      // as a returned envelope rather than a rejection, and without it the
      // `.catch` would be dead code. Still swallowed — the cursor is written on
      // every intersection and `markChannelRead` is a `GREATEST` update, so the
      // next scroll re-sends it.
      void markChannelReadAction({ workspaceId, teamId: channel.id, messageId })
        .then(unwrap)
        .catch(() => undefined)
    },
    [workspaceId, channel.id],
  )

  const openThread = useCallback(
    (rootId: number) => {
      setThreadRootId(rootId)
      // Seeded from what the feed already holds so the pane paints its root
      // instantly, then filled in by the fetch. Opening a thread should not
      // look like a loading screen when the root is on screen behind it.
      const root = feed.find((m) => m.id === rootId)
      setThread(root ? [root] : [])
      void loadThreadAction({ workspaceId, teamId: channel.id, rootId })
        .then((rows) => setThread(unwrap(rows)))
        .catch((error: unknown) => {
          // Said out loud rather than swallowed. The pane is already open on
          // the seeded root, so a silent failure is indistinguishable from a
          // thread that genuinely has no replies — which is the wrong thing to
          // let somebody believe about a conversation.
          toast({
            title: 'Could not open the thread',
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          })
        })
    },
    [workspaceId, channel.id, feed],
  )

  // `appendReply` lived here until R12-P3.1. It appended a reply the server had
  // already confirmed; `insertOptimistic` now puts the reply on screen before
  // the write starts and `settleOptimistic` swaps in the real row, so keeping
  // both would have put every reply in the thread twice.

  const join = useCallback(async () => {
    setJoining(true)
    try {
      setSlots(unwrap(await joinChannelAction({ workspaceId, workspaceSlug, teamId: channel.id })))
    } catch (error) {
      toast({
        title: 'Could not join the channel',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setJoining(false)
    }
  }, [workspaceId, workspaceSlug, channel.id])

  // --- Mentions that start work ---------------------------------------------

  /**
   * The reply count of every root we hold, so a ghost can tell when its answer
   * has actually landed.
   *
   * The answer arrives as a THREAD REPLY and the feed is roots only, so the
   * reply itself never appears in `feed` — the root's count going up is the
   * one signal that does, and it is the database's own `count(*)`, not a
   * tally kept here.
   */
  const replyCountByRoot = useMemo(() => new Map(feed.map((m) => [m.id, m.replyCount])), [feed])

  /**
   * Ghost rows, from BOTH sources, in one place.
   *
   * `dispatched` on a send is what makes the row appear in the same tick as
   * the message. `runs` is what makes it survive a reload: a person who
   * refreshes mid-turn must still see that an agent is working, and before
   * this the page came back looking like nothing had ever been started.
   */
  const addPending = useCallback((rows: PendingReply[]) => {
    if (rows.length === 0) return
    setPending((prev) => {
      const seen = new Set(prev.map((p) => p.runId))
      const fresh = rows.filter((r) => !seen.has(r.runId))
      return fresh.length === 0 ? prev : [...prev, ...fresh]
    })
  }, [])

  const retire = useCallback((runIds: number[]) => {
    if (runIds.length === 0) return
    const ids = new Set(runIds)
    setPending((prev) => prev.filter((p) => !ids.has(p.runId)))
    setRetiredRunIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [])

  const dismissPending = useCallback((runId: number) => retire([runId]), [retire])

  // Hydration from the runs map: any non-terminal run whose trigger message we
  // are showing is an agent that is working right now.
  useEffect(() => {
    const rows: PendingReply[] = []
    for (const [messageId, link] of runs) {
      if (isTerminalRunStatus(link.status)) continue
      if (retiredRunIds.has(link.runId)) continue
      if (link.sessionId == null) continue
      const message = feed.find((m) => m.id === messageId)
      if (!message) continue
      // The run carries a session, and a slot IS a session — that is the join
      // that names the agent without a second query. A run whose session is no
      // longer on the roster is skipped rather than labelled "unknown member".
      const slot = slots.find((sl) => sl.sessionId === link.sessionId && sl.agentId != null)
      if (!slot) continue
      const rootId = message.threadRootId ?? message.id
      rows.push({
        messageId,
        threadRootId: rootId,
        slotId: slot.id,
        displayName: slot.displayName,
        runId: link.runId,
        sessionId: link.sessionId,
        baselineReplyCount: replyCountByRoot.get(rootId) ?? 0,
      })
    }
    addPending(rows)
  }, [runs, feed, slots, retiredRunIds, replyCountByRoot, addPending])

  /**
   * Retiring a ghost when its answer lands.
   *
   * The root gaining a reply is the proof. NOT the run reaching a terminal
   * status: a run can finish a beat before its `team_send_message` row is
   * visible to the next poll, and dropping the row on `done` would blink the
   * answer out of existence for those few seconds. The dismiss button is the
   * escape hatch for a run that ends without ever posting.
   */
  useEffect(() => {
    const answered = pending.filter(
      (row) => (replyCountByRoot.get(row.threadRootId) ?? 0) > row.baselineReplyCount,
    )
    // Early return before any setState, so depending on `pending` here cannot
    // become a render loop.
    if (answered.length === 0) return
    retire(answered.map((row) => row.runId))
  }, [pending, replyCountByRoot, retire])

  /**
   * Which messages we have already asked about.
   *
   * `runs.channel_message_id` is written inside the same server action that
   * inserts the message, so a message that has no run when we first ask will
   * never gain one — which makes "ask once per id" correct rather than merely
   * cheap. One batched call per arriving BATCH; never one per row.
   */
  const runsAskedRef = useRef<Set<number>>(new Set(Object.keys(initialRuns).map(Number)))
  useEffect(() => {
    // Mount only. `feed` is deliberately NOT a dependency: this seeds the set
    // with the page the SERVER already resolved runs for, so the effect below
    // does not immediately re-ask for all two hundred of them. Re-running it on
    // every feed change would mark newly arrived messages as asked without ever
    // asking, and their "See full run" links would never appear.
    for (const message of feed) runsAskedRef.current.add(message.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unasked: number[] = []
    for (const message of [...feed, ...thread]) {
      if (runsAskedRef.current.has(message.id)) continue
      runsAskedRef.current.add(message.id)
      unasked.push(message.id)
    }
    if (unasked.length === 0) return
    let cancelled = false
    void loadChannelRunsAction({ workspaceId, teamId: channel.id, messageIds: unasked })
      .then((result) => {
        if (cancelled) return
        const entries = Object.entries(unwrap(result))
        if (entries.length === 0) return
        setRuns((prev) => {
          const next = new Map(prev)
          for (const [id, link] of entries) next.set(Number(id), link)
          return next
        })
      })
      // Deliberately quiet, and this one stays quiet: all it resolves is the
      // "See full run" link on a message. Interrupting a conversation to report
      // a missing decoration would cost more than the decoration is worth.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [feed, thread, workspaceId, channel.id])

  /** What a send tells us: the row, who it woke, and who it deliberately did
   * not. All three were already on the response and only the first was used. */
  const onDispatched = useCallback(
    (input: {
      message: RoomFeedMessage
      dispatched: Array<{ slotId: number; displayName: string; runId: number }>
      skipped: Array<{ slotId: number; displayName: string; reason: string }>
    }) => {
      // ROOTS ONLY. `listChannelFeed` selects `thread_root_id IS NULL`, so the
      // feed is the list of roots and nothing else; merging a thread reply
      // into it puts the same message on screen twice — once inside the
      // thread pane and once as a top-level row that no refresh ever removes,
      // because `mergeFeed` only ever adds. The thread pane's own
      // `onAppendReply` already puts the reply where it belongs and nudges the
      // root's reply count.
      const isReply = input.message.threadRootId != null
      if (!isReply) mergeFeed([input.message])
      const rootId = input.message.threadRootId ?? input.message.id
      addPending(
        input.dispatched.map((d) => ({
          messageId: input.message.id,
          threadRootId: rootId,
          slotId: d.slotId,
          displayName: d.displayName,
          runId: d.runId,
          sessionId: slots.find((sl) => sl.id === d.slotId)?.sessionId ?? null,
          // +1 when the message that named the agent is ITSELF a reply.
          //
          // `replyCountByRoot` is read from the render this callback closed
          // over, which is one tick before `onAppendReply`'s bump lands — so
          // it is the count BEFORE our own reply. Taking it as the baseline
          // means the very next render sees count > baseline and retires the
          // ghost instantly: mentioning an agent from the thread pane showed a
          // "replying…" row for a single frame and then went silent, which is
          // the exact bug this row exists to remove.
          baselineReplyCount: (replyCountByRoot.get(rootId) ?? 0) + (isReply ? 1 : 0),
        })),
      )
      if (input.skipped.length > 0) {
        setSkipped((prev) => [
          ...prev,
          ...input.skipped.map((sk) => ({ ...sk, messageId: input.message.id })),
        ])
      }
      // A dispatched run exists NOW; recording it here means the reload path
      // and the live path agree without waiting for a poll.
      if (input.dispatched.length > 0) {
        runsAskedRef.current.add(input.message.id)
        setRuns((prev) => {
          const next = new Map(prev)
          const first = input.dispatched[0]
          next.set(input.message.id, {
            runId: first.runId,
            sessionId: slots.find((sl) => sl.id === first.slotId)?.sessionId ?? null,
            status: 'queued',
          })
          return next
        })
      }
    },
    [mergeFeed, addPending, slots, replyCountByRoot],
  )

  /**
   * A decided request, dropped immediately.
   *
   * The POST already returned 200, so waiting for the next poll to notice
   * would leave a dead control on screen for up to a tick. Filtering locally
   * is free and the poll agrees with it within the same tick.
   */
  const onApprovalSettled = useCallback((externalId: string) => {
    setApprovals((prev) => prev.filter((row) => row.externalId !== externalId))
  }, [])

  /** A task chip, followed. The board is the other half of the product and
   * this is the seam between them. */
  const openTask = useCallback((taskId: number) => {
    setFocusTaskId(taskId)
    selectView('board')
  }, [selectView])

  const makeTaskFromMessage = useCallback(
    async (messageId: number): Promise<string | null> => {
      try {
        const { task } = unwrap(
          await createTaskFromMessageAction({ workspaceId, teamId: channel.id, messageId }),
        )
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]))
        // Patched locally rather than re-read: the action told us the id it
        // wrote, and re-fetching the room to show a chip we already hold is
        // the round trip on a UI action D0 forbids.
        patchMessage(messageId, { taskId: task.id })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : 'Something went wrong.'
      }
    },
    [workspaceId, channel.id, patchMessage],
  )

  /**
   * Slash commands (item 7).
   *
   * Every one of these is a call the room already makes; nothing here is a new
   * capability with a new code path behind it. `/status` deliberately posts
   * NOTHING — it answers a question, and answering it by writing a message
   * into the channel would make everyone else read the answer to a question
   * they did not ask.
   */
  const runCommand = useCallback(
    async (command: { name: string; rest: string }): Promise<string | null> => {
      const rest = command.rest.trim()

      if (command.name === 'canvas') {
        setCanvasOpen(true)
        return null
      }

      if (command.name === 'status') {
        const working = health.filter((h) => h.state === 'running').length
        const lostNow = health.filter((h) => h.state === 'lost')
        const waiting = health.filter((h) => h.state === 'awaiting_approval')
        toast({
          title: `#${channel.name} · ${slots.length} ${slots.length === 1 ? 'member' : 'members'}`,
          description:
            `${working} working · ${claimableIds.length} claimable ${claimableIds.length === 1 ? 'task' : 'tasks'} · ` +
            `${stop.inFlightRunIds.length} ${stop.inFlightRunIds.length === 1 ? 'turn' : 'turns'} in flight` +
            (lostNow.length > 0 ? `. Lost: ${lostNow.map((h) => h.displayName).join(', ')}` : '') +
            (waiting.length > 0
              ? `. ${SLOT_STATE_LABEL.awaiting_approval}: ${waiting.map((h) => h.displayName).join(', ')}`
              : ''),
        })
        return null
      }

      if (command.name === 'task') {
        if (!rest) return 'Say what the task is: /task Fix the flaky login test'
        // RETURNED, not thrown. The contract this function declares is
        // `Promise<string | null>` — a string is the reason it did not run,
        // printed under the composer beside the text that caused it. Throwing
        // instead escaped the composer's `try/finally` (which has no `catch`),
        // became an unhandled rejection, and left a refused `/task` looking
        // exactly like a successful one: nothing on screen either way.
        try {
          const task = unwrap(
            await createTeamTaskAction({
              workspaceId,
              teamId: channel.id,
              subject: subjectFromBody(rest),
              description: rest === subjectFromBody(rest) ? undefined : rest,
              ownerSlotId: null,
              blockedBy: [],
            }),
          )
          setTasks((prev) => [...prev, task])
          return null
        } catch (error) {
          return error instanceof Error ? error.message : 'Something went wrong.'
        }
      }

      if (command.name === 'assign') {
        if (!rest.startsWith('@')) return 'Name a member first: /assign @Coder Fix the flaky login test'
        // Longest display name first, so "@Coder 2" is never eaten by "@Coder"
        // — the same ordering `parseMentions` and `splitMentions` use, for the
        // same reason.
        const ordered = [...slots].sort((a, b) => b.displayName.length - a.displayName.length)
        const lower = rest.toLowerCase()
        const target = ordered.find((sl) => lower.startsWith(`@${sl.displayName.toLowerCase()}`))
        if (!target) return `Nobody in this channel is called ${rest.split(/\s+/)[0]}.`
        const subject = rest.slice(target.displayName.length + 1).trim()
        if (!subject) return `Say what ${target.displayName} should do: /assign @${target.displayName} <subject>`
        try {
          const task = unwrap(
            await createTeamTaskAction({
              workspaceId,
              teamId: channel.id,
              subject: subjectFromBody(subject),
              description: subject === subjectFromBody(subject) ? undefined : subject,
              ownerSlotId: target.id,
              blockedBy: [],
            }),
          )
          setTasks((prev) => [...prev, task])
          return null
        } catch (error) {
          return error instanceof Error ? error.message : 'Something went wrong.'
        }
      }

      // Unreachable through the composer, which refuses an unknown name before
      // it ever gets here. Kept so a future command added to SLASH_COMMANDS
      // without a branch fails loudly instead of silently doing nothing.
      return `/${command.name} is listed but not wired up yet.`
    },
    [workspaceId, channel.id, channel.name, slots, health, claimableIds, stop.inFlightRunIds.length],
  )

  const leader = useMemo(() => slots.find((s) => s.role === 'leader') ?? null, [slots])
  const claimableCount = claimableIds.length
  const lost = useMemo(() => health.filter((h) => h.state === 'lost'), [health])
  const awaitingApproval = useMemo(() => health.filter((h) => h.state === 'awaiting_approval'), [health])
  const inFlight = stop.inFlightRunIds.length

  /**
   * R6.6's room-wide stop.
   *
   * The button waits for the server rather than guessing. "Asked 4 turns to
   * stop" is a claim about other processes, and it is the one place in this
   * room where an optimistic update could lie about the machinery. Stopping is
   * a rare, deliberate action, so the round trip is the honest cost — unlike
   * sending a message, where the row is already known and D0 forbids it.
   */
  const stopRoom = useCallback(async () => {
    setStopping(true)
    try {
      const result = unwrap(await stopTeamRoomAction({ workspaceId, teamId: channel.id }))
      toast({
        title:
          result.stopped.length === 0
            ? 'Nothing was running'
            : `Asked ${result.stopped.length} turn${result.stopped.length === 1 ? '' : 's'} to stop`,
        description:
          result.stopped.length === 0
            ? 'No member turn was in flight.'
            : 'Cooperative: everything already streamed is kept, and each run settles as cancelled.' +
              (result.alreadySettled.length > 0
                ? ` ${result.alreadySettled.length} had already finished.`
                : ''),
      })
      // Only the fact the server just confirmed. `inFlightRunIds` is
      // deliberately left alone: a cooperative stop is a REQUEST, and those
      // runs are still winding down until each one settles. Zeroing the count
      // here would disable the button and tell the room nothing is running
      // while turns are visibly still finishing — the next poll reports what
      // actually happened.
      setStop((prev) => ({ ...prev, requestedAt: new Date().toISOString() }))
    } catch (error) {
      toast({
        title: 'Could not stop the room',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setStopping(false)
    }
  }, [workspaceId, channel.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate text-2xl font-semibold">
            <span aria-hidden className="text-black/25 dark:text-white/25">
              {channel.isPrivate ? <Lock size={18} /> : <Hash size={20} />}
            </span>
            {channel.name}
          </h1>
          <p className="mt-0.5 truncate text-sm text-black/50 dark:text-white/50">
            {channel.topic ? `${channel.topic} · ` : channel.description ? `${channel.description} · ` : ''}
            {slots.length} {slots.length === 1 ? 'member' : 'members'} ·{' '}
            {channel.workspaceMode === 'shared' ? 'shared worktree' : 'worktree per member'}
          </p>
        </div>

        {/*
          R12-P1.5 — the room's connection line, and deliberately the same
          object as `components/thread/connection-status-banner.tsx`: the same
          amber, the same spinner, the same "Retry now". A run stream dropping
          and a room poll dropping are two mechanisms but one fact to whoever is
          reading them, and giving them two treatments would make one product
          look like two.

          Smaller than its sibling because it has less to say. The poll never
          gives up, so there is no terminal "offline" state to warn about; and
          it sits in the header rather than across the top of the feed because
          the space above a conversation belongs to the conversation.
        */}
        {pollFailures >= POLLS_BEFORE_RECONNECTING && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400"
            title="The room could not reach the server on its last few polls. It keeps trying."
          >
            <Loader2 size={12} className="animate-spin" />
            Reconnecting…
            <span className="tabular-nums opacity-70">({pollFailures})</span>
            <button
              type="button"
              onClick={() => pollNowRef.current?.()}
              className="font-medium underline-offset-2 hover:underline"
            >
              Retry now
            </button>
          </span>
        )}

        <Button
          type="button"
          size="sm"
          variant={canvasOpen ? 'default' : 'outline'}
          onClick={() => setCanvasOpen((open) => !open)}
          title="The channel's document — a real page, created the first time you open it"
        >
          <NotebookPen size={14} />
          Canvas
        </Button>

        {/*
          Stop is a header control, not a per-lane one, because the thing it
          stops is the room. It is disabled when nothing is in flight rather
          than hidden: a Stop that appears and vanishes teaches people to hunt
          for it, and its label already says how many turns it would reach.
        */}
        <Button
          type="button"
          size="sm"
          variant={inFlight > 0 ? 'destructive' : 'outline'}
          disabled={stopping || inFlight === 0}
          onClick={() => void stopRoom()}
          title={
            inFlight === 0
              ? 'No member turn is in flight.'
              : `Ask all ${inFlight} in-flight member turns to stop cooperatively.`
          }
        >
          <OctagonX size={14} />
          {stopping ? 'Stopping…' : inFlight === 0 ? 'Stop room' : `Stop room (${inFlight})`}
        </Button>

        <nav className="inline-flex items-center gap-0.5 rounded-lg border border-black/10 p-0.5 dark:border-white/10">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => selectView(id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm',
                view === id
                  ? 'bg-black/[.06] font-medium dark:bg-white/[.10]'
                  : 'text-black/55 hover:bg-black/[.04] dark:text-white/55 dark:hover:bg-white/[.06]',
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
      </header>

      {/*
        The honesty banner R6.3 asks for. It is not decoration: it states which
        of the two modes the room is actually in, and the claimable count is
        the database's own answer (`claimableTasks`), not a guess. A stalled
        leader degrades the team to self-service, and the UI has to say so
        rather than continuing to look busy.

        Shown outside the Channel view only. In a chat client the space above
        the conversation belongs to the conversation; the delegation state is
        what Lanes and Board are for, and a permanent paragraph over the feed
        is the thing that stops it feeling like a messaging product.
      */}
      {view !== 'channel' && (
        <p className="mb-3 rounded-lg border border-black/10 px-3 py-2 text-xs text-black/55 dark:border-white/10 dark:text-white/55">
          {leader ? (
            <>
              <span className="font-medium text-black/75 dark:text-white/75">{leader.displayName}</span> leads this
              room. The board is still authoritative: {claimableCount}{' '}
              {claimableCount === 1 ? 'task is' : 'tasks are'} claimable by any idle member right now, so a stalled
              leader degrades the team to self-service instead of stopping it.
            </>
          ) : (
            <>
              No leader assigned — members self-serve from the board. {claimableCount}{' '}
              {claimableCount === 1 ? 'task is' : 'tasks are'} claimable right now.
            </>
          )}
        </p>
      )}

      {/*
        R6.6 — the reliability line. Present only when there is something to
        say: a room where everyone is fine gets no banner at all, so the banner
        appearing is itself the signal. Every number here is the sweep's own
        answer, not a guess from message timestamps.
      */}
      {(lost.length > 0 || awaitingApproval.length > 0 || stop.requestedAt) && (
        <div className="mb-3 space-y-1.5">
          {lost.length > 0 && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/[.04] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <span className="font-medium">
                {lost.length} {lost.length === 1 ? 'member is' : 'members are'} lost.
              </span>{' '}
              {lost
                .map(
                  (h) =>
                    `${h.displayName} (quiet ${formatSilence(h.silentForMs)}${
                      h.lostReason ? `; ${h.lostReason}` : ''
                    })`,
                )
                .join(' · ')}{' '}
              Anything they were holding has been returned to the board, so an idle member can pick it up.
            </p>
          )}
          {awaitingApproval.length > 0 && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/[.04] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="font-medium">Waiting on you:</span>{' '}
              {awaitingApproval.map((h) => h.displayName).join(', ')} raised the same approval card a solo run
              raises — answer it in the Inbox or in that member&apos;s thread. These members are not counted as
              lost while a decision is outstanding.
            </p>
          )}
          {stop.requestedAt && (
            <p className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
              <span>
                A room-wide stop was requested {formatRelativeTime(stop.requestedAt)}.
                {inFlight > 0
                  ? ` ${inFlight} turn${inFlight === 1 ? ' is' : 's are'} still winding down.`
                  : ' Nothing is running.'}{' '}
                Silence is expected for a moment, so nobody is marked lost for it straight away.
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  void clearTeamStopAction({ workspaceId, teamId: channel.id })
                    .then((result) => {
                      unwrap(result)
                      setStop((prev) => ({ ...prev, requestedAt: null, requestedBy: null }))
                    })
                    // Toasted rather than swallowed: a banner that stays exactly
                    // where it was is what a click that never reached the server
                    // and a click that did nothing both look like.
                    .catch((error: unknown) =>
                      toast({
                        title: 'Could not clear the stop',
                        description: error instanceof Error ? error.message : undefined,
                        variant: 'destructive',
                      }),
                    )
                }
              >
                Clear
              </Button>
            </p>
          )}
        </div>
      )}

      {/* R12-P3.4 - no `gap` any more. The panes are separated by their own
          draggable divider, and a gutter beside a hairline reads as two
          boundaries where there is one. */}
      <div className="flex min-h-0 flex-1">
        {view === 'channel' && (
          <ChannelView
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            teamId={channel.id}
            slots={slots}
            mySlotId={mySlotId}
            feed={feed}
            tasks={tasks}
            runs={runs}
            pending={pending}
            skipped={skipped}
            approvals={approvals}
            currentUserId={currentUserId}
            onApprovalSettled={onApprovalSettled}
            typingSlotIds={typingSlotIdsOthers}
            onTyping={notifyTyping}
            unreadBoundary={unreadBoundaryRef.current}
            unreadAtOpen={initialUnread.unreadCount}
            mentionsAtOpen={initialUnread.mentionCount}
            threadRootId={threadRootId}
            onOpenThread={openThread}
            onOpenRun={openRunSheet}
            onDispatched={onDispatched}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSettle={settleOptimistic}
            onOptimisticDiscard={discardOptimistic}
            onPatchMessage={patchMessage}
            onDismissPending={dismissPending}
            onOpenTask={openTask}
            onMakeTask={makeTaskFromMessage}
            onCommand={runCommand}
            onSeen={onSeen}
            onJoin={() => void join()}
            joining={joining}
          />
        )}
        {view === 'lanes' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <LanesView
              workspaceSlug={workspaceSlug}
              slots={slots}
              messages={messages}
              tasks={tasks}
              health={health}
            />
          </div>
        )}
        {view === 'board' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BoardView
              workspaceId={workspaceId}
              teamId={channel.id}
              slots={slots}
              tasks={tasks}
              claimableIds={claimableIds}
              focusTaskId={focusTaskId}
              onFocusHandled={() => setFocusTaskId(null)}
              onTasksChanged={setTasks}
            />
          </div>
        )}

        {/* Both panes sit BESIDE the feed, never over it. A thread you cannot
            read the room from, and a canvas that hides the conversation it is
            about, are the two mistakes this layout exists to avoid. */}
        {view === 'channel' && threadRootId != null && (
          <ThreadPane
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            teamId={channel.id}
            rootId={threadRootId}
            messages={thread}
            slots={slots}
            tasks={tasks}
            runs={runs}
            pending={pending}
            approvals={approvals}
            currentUserId={currentUserId}
            onApprovalSettled={onApprovalSettled}
            typingSlotIds={typingSlotIdsOthers}
            onTyping={notifyTyping}
            mySlotId={mySlotId}
            onClose={() => {
              setThreadRootId(null)
              setThread([])
            }}
            onDispatched={onDispatched}
            onOptimisticInsert={insertOptimistic}
            onOptimisticSettle={settleOptimistic}
            onOptimisticDiscard={discardOptimistic}
            onPatchMessage={patchMessage}
            onDismissPending={dismissPending}
            onOpenRun={openRunSheet}
            onOpenTask={openTask}
          />
        )}
        {canvasOpen && (
          <CanvasPane
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            teamId={channel.id}
            channelName={channel.name}
            onClose={() => setCanvasOpen(false)}
          />
        )}

        <RosterPanel
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          teamId={channel.id}
          channelName={channel.name}
          slots={slots}
          mySlotId={mySlotId}
          tasks={tasks}
          health={health}
          agents={agents}
          users={users}
          onSlotsChanged={setSlots}
        />

        <RunDetailSheet
          open={sheetRunId != null}
          onOpenChange={(open) => {
            if (!open) setSheetRunId(null)
          }}
          runId={sheetRunId}
          loader={loadRunSnapshot}
          fullPageHref={sheetSessionId != null ? `/workspace/${workspaceSlug}/work?session=${sheetSessionId}` : undefined}
        />
      </div>
    </div>
  )
}
