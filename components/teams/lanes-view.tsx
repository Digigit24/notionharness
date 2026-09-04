'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Crown, ExternalLink } from 'lucide-react'
import type { TeamMessage, TeamTask } from '@/lib/broker'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { TASK_STATUS_CLASS, TASK_STATUS_LABEL, colourOf, senderLabel, type TeamSlotView } from './shared'

/** The last few rows a lane shows. A lane is a glance, not a transcript — the
 * full history is one click away in the channel or in Work. */
const LANE_MESSAGE_COUNT = 8

/**
 * What a lane can say about a member without inventing anything.
 *
 * R6.4 wants presence — idle, thinking, running a tool, waiting on approval,
 * blocked, lost — "derived from the run and its heartbeat rather than
 * guessed". There is no heartbeat producer for team slots: R6.6 is unbuilt and
 * nothing writes a per-slot liveness row, so *thinking*, *running a tool* and
 * *lost* are not derivable today and are deliberately absent rather than
 * approximated from message timestamps, which would look like presence and be
 * fiction.
 *
 * What IS real is the board: a slot either owns work or it does not, and a
 * task it owns is either blocked or not. That is what this returns.
 */
function laneState(tasks: TeamTask[]): { label: string; tone: string } {
  const active = tasks.filter((t) => t.status === 'in_progress' || t.status === 'claimed')
  const blocked = tasks.filter((t) => t.status === 'blocked')
  if (active.length > 0) {
    return {
      label: `holding ${active.length} ${active.length === 1 ? 'task' : 'tasks'}`,
      tone: 'text-indigo-600 dark:text-indigo-400',
    }
  }
  if (blocked.length > 0) {
    return { label: `blocked on ${blocked.length}`, tone: 'text-amber-600 dark:text-amber-400' }
  }
  return { label: 'no assigned work', tone: 'text-black/45 dark:text-white/45' }
}

export function LanesView({
  workspaceSlug,
  slots,
  messages,
  tasks,
}: {
  workspaceSlug: string
  slots: TeamSlotView[]
  messages: TeamMessage[]
  tasks: TeamTask[]
}) {
  // Bucketed once for the whole view rather than filtered inside each lane:
  // with n slots and m messages the per-lane filter is n×m on every render,
  // and the feed is the array that grows without bound.
  const byLane = useMemo(() => {
    const map = new Map<number, { messages: TeamMessage[]; tasks: TeamTask[] }>()
    for (const slot of slots) map.set(slot.id, { messages: [], tasks: [] })
    for (const message of messages) {
      if (message.fromSlotId != null) map.get(message.fromSlotId)?.messages.push(message)
      // A broadcast belongs in every lane it was addressed to; a directed
      // message belongs in the recipient's lane too, or delegation would be
      // invisible from the side that received it.
      if (message.toSlotId != null && message.toSlotId !== message.fromSlotId) {
        map.get(message.toSlotId)?.messages.push(message)
      }
    }
    for (const task of tasks) {
      if (task.ownerSlotId != null) map.get(task.ownerSlotId)?.tasks.push(task)
    }
    return map
  }, [slots, messages, tasks])

  if (slots.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-black/15 px-6 py-12 text-center text-sm text-black/45 dark:border-white/15 dark:text-white/45">
        This team has no slots yet. Add one from the roster on the right.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {slots.map((slot) => {
          const lane = byLane.get(slot.id) ?? { messages: [], tasks: [] }
          const state = laneState(lane.tasks)
          return (
            <section
              key={slot.id}
              className="flex min-h-0 w-72 shrink-0 flex-col rounded-xl border border-black/10 dark:border-white/10"
            >
              <header className="shrink-0 border-b border-black/10 px-3 py-2 dark:border-white/10">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colourOf(slot) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{slot.displayName}</span>
                  {slot.role === 'leader' && (
                    <Crown size={13} className="shrink-0 text-amber-500" aria-label="Leader" />
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-black/45 dark:text-white/45">
                  {slot.agentName ?? `agent ${slot.agentId}`}
                </p>
                <p className={cn('mt-0.5 text-xs', state.tone)}>{state.label}</p>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {lane.tasks.length > 0 && (
                  <ul className="mb-3 space-y-1">
                    {lane.tasks.map((task) => (
                      <li key={task.id} className="text-xs">
                        <span className={cn('mr-1.5', TASK_STATUS_CLASS[task.status])}>
                          {TASK_STATUS_LABEL[task.status]}
                        </span>
                        <span className="text-black/70 dark:text-white/70">{task.subject}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {lane.messages.length === 0 ? (
                  <p className="py-4 text-center text-xs text-black/35 dark:text-white/35">Nothing said yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {lane.messages.slice(-LANE_MESSAGE_COUNT).map((message) => (
                      <li key={`${slot.id}-${message.id}`} className="text-xs">
                        <div className="flex items-baseline gap-1.5 text-[11px] text-black/40 dark:text-white/40">
                          <span>{senderLabel(slots, message.fromSlotId)}</span>
                          <span className="ml-auto">{formatRelativeTime(message.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words">{message.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <footer className="shrink-0 border-t border-black/10 p-2 dark:border-white/10">
                {slot.sessionId != null ? (
                  <Link
                    href={`/workspace/${workspaceSlug}/work?session=${slot.sessionId}`}
                    className="inline-flex items-center gap-1.5 text-xs text-black/60 hover:underline dark:text-white/60"
                  >
                    <ExternalLink size={12} />
                    Open thread
                  </Link>
                ) : (
                  <span className="text-xs text-black/40 dark:text-white/40">No conversation bound</span>
                )}
              </footer>
            </section>
          )
        })}
      </div>

      {/*
        Stated placeholder, not a fake panel. R6.4 also asks for a strip of
        every member's live terminal at once, and for a merge action per member
        worktree. Neither is possible from this unit yet: a lane renders the
        mailbox rows it has, but streaming a member's turn needs the run event
        stream mounted per slot (Work's territory) and merging needs the slot
        bound to a worktree, which nothing writes — `team_members.worktree_id`
        is null for every slot this UI creates.
      */}
      <p className="mt-2 shrink-0 text-[11px] text-black/35 dark:text-white/35">
        Lanes show the board and the mailbox, which are real. Live streaming text, tool cards and terminals per lane
        are not wired up: that needs the run event stream mounted per slot. No slot is bound to a worktree yet, so
        there is no merge action here either.
      </p>
    </div>
  )
}
