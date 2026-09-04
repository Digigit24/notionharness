'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, MessageSquare, Network } from 'lucide-react'
import type { Team, TeamMessage, TeamTask } from '@/lib/broker'
import { cn } from '@/lib/utils'
import { markRoomReadAction, pollTeamRoomAction } from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import type { TeamSlotView } from './shared'
import { ChannelFeed } from './channel-feed'
import { LanesView } from './lanes-view'
import { BoardView } from './board-view'
import { RosterPanel } from './roster-panel'
import type { TeamAgentOption } from './create-team-form'

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
 * The room: one set of data, three views over it (R6.4).
 *
 * All three read the SAME arrays held here — messages, tasks, slots — so
 * switching views is a render, never a fetch. That is also why view state is
 * local rather than a route segment or a search param the server reads: a
 * round trip to change tab is the exact latency D0 rules out. The choice is
 * still mirrored into the URL with `history.replaceState` so a reload or a
 * shared link lands on the same view without Next re-rendering the page.
 */
export function TeamRoom({
  workspaceId,
  workspaceSlug,
  team,
  slots: initialSlots,
  initialMessages,
  initialTasks,
  initialClaimableIds,
  agents,
}: {
  workspaceId: number
  workspaceSlug: string
  team: Team
  slots: TeamSlotView[]
  initialMessages: TeamMessage[]
  initialTasks: TeamTask[]
  initialClaimableIds: number[]
  agents: TeamAgentOption[]
}) {
  const [view, setView] = useState<RoomView>('channel')
  const [slots, setSlots] = useState(initialSlots)
  const [messages, setMessages] = useState(initialMessages)
  const [tasks, setTasks] = useState(initialTasks)
  const [claimableIds, setClaimableIds] = useState(initialClaimableIds)
  const [focusSlotId, setFocusSlotId] = useState<number | null>(null)

  // The server re-renders this component with fresh props after any action
  // that calls revalidatePath (adding a slot, changing the leader). Without
  // this the roster would show stale rows after a refresh.
  useEffect(() => setSlots(initialSlots), [initialSlots])

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

  /** Appends only rows we do not already hold. The poll and an optimistic send
   * can both deliver the same message — the send returns the inserted row, and
   * the next poll reads forward from a cursor that may predate it. */
  const mergeMessages = useCallback((incoming: TeamMessage[]) => {
    if (incoming.length === 0) return
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      const fresh = incoming.filter((m) => !seen.has(m.id))
      if (fresh.length === 0) return prev
      return [...prev, ...fresh].sort((a, b) => a.id - b.id)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      // A backgrounded tab polling a room nobody is looking at is pure waste.
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        const delta = await pollTeamRoomAction({
          workspaceId,
          teamId: team.id,
          sinceMessageId: lastMessageIdRef.current,
        })
        if (cancelled) return
        mergeMessages(delta.messages)
        setTasks(delta.tasks)
        setClaimableIds(delta.claimableIds)
        if (delta.messages.length > 0) {
          // Reading a room while looking at it is what "read" means; anything
          // that arrives while the tab is hidden stays unread and keeps the
          // channel list bold.
          void markRoomReadAction({
            workspaceId,
            teamId: team.id,
            messageIds: delta.messages.map((m) => m.id),
          }).catch(() => undefined)
        }
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
  }, [workspaceId, team.id, mergeMessages])

  useEffect(() => {
    const unread = initialMessages.filter((m) => m.readAt == null).map((m) => m.id)
    if (unread.length === 0) return
    void markRoomReadAction({ workspaceId, teamId: team.id, messageIds: unread }).catch(() => undefined)
  }, [workspaceId, team.id, initialMessages])

  const leader = useMemo(() => slots.find((s) => s.role === 'leader') ?? null, [slots])
  const claimableCount = claimableIds.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{team.name}</h1>
          <p className="mt-0.5 text-sm text-black/50 dark:text-white/50">
            {team.description ? `${team.description} · ` : ''}
            {slots.length} {slots.length === 1 ? 'slot' : 'slots'} ·{' '}
            {team.workspaceMode === 'shared' ? 'shared worktree' : 'worktree per member'}
          </p>
        </div>
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
      */}
      <p className="mb-3 rounded-lg border border-black/10 px-3 py-2 text-xs text-black/55 dark:border-white/10 dark:text-white/55">
        {leader ? (
          <>
            <span className="font-medium text-black/75 dark:text-white/75">{leader.displayName}</span> leads this room.
            The board is still authoritative: {claimableCount}{' '}
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

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === 'channel' && (
            <ChannelFeed
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              teamId={team.id}
              slots={slots}
              messages={messages}
              tasks={tasks}
              focusSlotId={focusSlotId}
              onFocusSlot={setFocusSlotId}
              onAppendMessage={(m) => mergeMessages([m])}
            />
          )}
          {view === 'lanes' && (
            <LanesView workspaceSlug={workspaceSlug} slots={slots} messages={messages} tasks={tasks} />
          )}
          {view === 'board' && (
            <BoardView
              workspaceId={workspaceId}
              teamId={team.id}
              slots={slots}
              tasks={tasks}
              claimableIds={claimableIds}
              onTasksChanged={setTasks}
            />
          )}
        </div>

        <RosterPanel
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          teamId={team.id}
          slots={slots}
          tasks={tasks}
          agents={agents}
          onSlotsChanged={setSlots}
        />
      </div>
    </div>
  )
}
