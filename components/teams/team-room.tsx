'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, Hash, Lock, MessageSquare, Network, NotebookPen, OctagonX } from 'lucide-react'
import type { TeamTask } from '@/lib/broker'
import type { TeamRoomMessage, TeamSlotHealth, TeamStopState } from '@/lib/teams/reliability'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { formatRelativeTime } from '@/lib/relative-time'
import {
  clearTeamStopAction,
  joinChannelAction,
  loadThreadAction,
  markChannelReadAction,
  pollTeamRoomAction,
  stopTeamRoomAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import type { Channel } from '@/app/(app)/workspace/[workspaceSlug]/teams/data'
import { formatSilence, type RoomFeedMessage, type TeamAgentOption, type TeamSlotView, type TeamUserOption } from './shared'
import { ChannelView } from './channel-view'
import { ThreadPane } from './thread-pane'
import { CanvasPane } from './canvas-pane'
import { LanesView } from './lanes-view'
import { BoardView } from './board-view'
import { RosterPanel } from './roster-panel'

type RoomView = 'channel' | 'lanes' | 'board'

const VIEWS: Array<{ id: RoomView; label: string; icon: typeof MessageSquare }> = [
  { id: 'channel', label: 'Channel', icon: MessageSquare },
  { id: 'lanes', label: 'Lanes', icon: Columns3 },
  { id: 'board', label: 'Board', icon: Network },
]

/** How often the room asks what changed. Six seconds is a compromise, not a
 * target: it is slow enough that an idle room costs almost nothing and fast
 * enough that a delegation does not feel lost. The real fix is a push channel
 * — see `pollTeamRoomAction`. */
const POLL_MS = 6000

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
  const [joining, setJoining] = useState(false)
  const [threadRootId, setThreadRootId] = useState<number | null>(null)
  const [thread, setThread] = useState<RoomFeedMessage[]>([])
  const [canvasOpen, setCanvasOpen] = useState(false)

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

  const patchMessage = useCallback((id: number, patch: Partial<RoomFeedMessage>) => {
    setFeed((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
    setThread((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }, [])

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
        const delta = await pollTeamRoomAction({
          workspaceId,
          teamId: channel.id,
          sinceMessageId: lastMessageIdRef.current,
          feedSince: feedSinceRef.current,
          threadRootId: threadRootIdRef.current,
        })
        if (cancelled) return
        mergeMessages(delta.messages)
        mergeFeed(delta.feed)
        if (delta.thread) setThread(delta.thread)
        setTasks(delta.tasks)
        setClaimableIds(delta.claimableIds)
        setHealth(delta.health)
        setStop(delta.stop)
      } catch {
        // Swallowed on purpose: a failed poll is not an event worth a toast
        // every six seconds. The next tick either works or the page is dead
        // anyway, and every mutation surfaces its own error.
      } finally {
        inFlight = false
      }
    }
    const handle = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [workspaceId, channel.id, mergeMessages, mergeFeed])

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
      void markChannelReadAction({ workspaceId, teamId: channel.id, messageId }).catch(() => undefined)
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
        .then((rows) => setThread(rows))
        .catch(() => undefined)
    },
    [workspaceId, channel.id, feed],
  )

  const appendReply = useCallback(
    (reply: RoomFeedMessage) => {
      setThread((prev) => (prev.some((m) => m.id === reply.id) ? prev : [...prev, reply]))
      // The root's "N replies" is a computed column, so it is nudged here
      // rather than waiting up to six seconds for the poll to recompute it.
      // The next refresh replaces it with the database's own answer.
      if (reply.threadRootId != null) {
        setFeed((prev) =>
          prev.map((m) =>
            m.id === reply.threadRootId
              ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: reply.createdAt }
              : m,
          ),
        )
      }
    },
    [],
  )

  const join = useCallback(async () => {
    setJoining(true)
    try {
      setSlots(await joinChannelAction({ workspaceId, workspaceSlug, teamId: channel.id }))
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
      const result = await stopTeamRoomAction({ workspaceId, teamId: channel.id })
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
                    .then(() => setStop((prev) => ({ ...prev, requestedAt: null, requestedBy: null })))
                    .catch(() => undefined)
                }
              >
                Clear
              </Button>
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {view === 'channel' && (
          <ChannelView
            workspaceId={workspaceId}
            teamId={channel.id}
            slots={slots}
            mySlotId={mySlotId}
            feed={feed}
            tasks={tasks}
            unreadBoundary={unreadBoundaryRef.current}
            threadRootId={threadRootId}
            onOpenThread={openThread}
            onPosted={(message) => mergeFeed([message])}
            onPatchMessage={patchMessage}
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
            teamId={channel.id}
            rootId={threadRootId}
            messages={thread}
            slots={slots}
            tasks={tasks}
            mySlotId={mySlotId}
            onClose={() => {
              setThreadRootId(null)
              setThread([])
            }}
            onAppendReply={appendReply}
            onPatchMessage={patchMessage}
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
          slots={slots}
          mySlotId={mySlotId}
          tasks={tasks}
          health={health}
          agents={agents}
          users={users}
          onSlotsChanged={setSlots}
        />
      </div>
    </div>
  )
}
