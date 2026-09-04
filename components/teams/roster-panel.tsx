'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Crown, MailX, Trash2, UserPlus } from 'lucide-react'
import type { TeamTask } from '@/lib/broker'
import type { TeamRoomMessage, TeamSlotHealth } from '@/lib/teams/reliability'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  SLOT_STATE_CLASS,
  SLOT_STATE_DOT,
  SLOT_STATE_LABEL,
  colourOf,
  formatSilence,
  healthBySlot,
  tasksForSlot,
  type TeamSlotView,
} from './shared'
import type { TeamAgentOption } from './create-team-form'
import {
  addSlotAction,
  deleteTeamAction,
  listTeamDeadLettersAction,
  removeSlotAction,
  setLeaderAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'

/**
 * The roster: who is in the room, who leads, and how to change that.
 *
 * Present in all three views rather than hidden behind a settings screen,
 * because membership is the thing you adjust while watching the room work —
 * a member that turns out to be redundant, or a leader that needs replacing.
 *
 * Adding an agent that is already in the roster is allowed and is not a
 * mistake: it creates a SECOND slot with its own name, colour and thread. The
 * picker therefore never disables an agent already present.
 *
 * R6.6 put liveness here rather than on a separate health screen, because this
 * is the list a person is already looking at when they wonder whether a member
 * is stuck — and because a lost slot that renders identically to a working one
 * is bookkeeping, not reliability.
 */
export function RosterPanel({
  workspaceId,
  workspaceSlug,
  teamId,
  slots,
  tasks,
  health,
  agents,
  onSlotsChanged,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  slots: TeamSlotView[]
  tasks: TeamTask[]
  health: TeamSlotHealth[]
  agents: TeamAgentOption[]
  onSlotsChanged: (slots: TeamSlotView[]) => void
}) {
  const router = useRouter()
  const healthOf = healthBySlot(health)
  const [addingAgentId, setAddingAgentId] = useState<number | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  // Fetched on demand, not with every poll. Undeliverable mail only changes
  // when somebody removes a slot, so shipping the list on a six-second cadence
  // would be a payload that is almost always empty and always identical.
  const [deadLetters, setDeadLetters] = useState<TeamRoomMessage[] | null>(null)

  async function run(work: () => Promise<void>, failure: string) {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      toast({
        title: failure,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto">
      <div>
        <h2 className="mb-1.5 text-xs font-medium text-black/50 dark:text-white/50">
          Roster · {slots.length} {slots.length === 1 ? 'slot' : 'slots'}
        </h2>
        <ul className="space-y-1">
          {slots.map((slot) => {
            const owned = tasksForSlot(tasks, slot.id)
            const state = healthOf.get(slot.id)
            return (
              <li
                key={slot.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2 py-1.5',
                  state?.state === 'lost'
                    ? 'border-red-500/40 bg-red-500/[.04]'
                    : 'border-black/10 dark:border-white/10',
                )}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: colourOf(slot) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{slot.displayName}</span>
                  <span className="block truncate text-[11px] text-black/40 dark:text-white/40">
                    {slot.agentName ?? `agent ${slot.agentId}`}
                    {owned.length > 0 ? ` · ${owned.length} assigned` : ''}
                  </span>
                  {/* The heartbeat, in the row it describes. `silentForMs` is
                      null when nothing has ever been observed for this slot,
                      which is genuinely different from "seen just now" and is
                      printed as such rather than as 0s. */}
                  {state && (
                    <span
                      className={cn('mt-0.5 flex items-center gap-1 text-[11px]', SLOT_STATE_CLASS[state.state])}
                      title={
                        state.lostReason ??
                        (state.lastSeenAt
                          ? `Last sign of life ${formatSilence(state.silentForMs)} ago.`
                          : 'Nothing has ever been observed for this slot.')
                      }
                    >
                      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', SLOT_STATE_DOT[state.state])} />
                      {SLOT_STATE_LABEL[state.state]}
                      {(state.state === 'lost' || state.state === 'silent') && (
                        <span className="opacity-70">· quiet {formatSilence(state.silentForMs)}</span>
                      )}
                      {state.pendingApprovals > 0 && (
                        <span className="opacity-70">
                          · {state.pendingApprovals} card{state.pendingApprovals === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant={slot.role === 'leader' ? 'default' : 'ghost'}
                  title={slot.role === 'leader' ? 'Leads this team — click to clear' : 'Make leader'}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = slot.role === 'leader' ? null : slot.id
                      await setLeaderAction({ workspaceId, workspaceSlug, teamId, slotId: next })
                      // Applied locally as well as revalidated, because at
                      // most one row can be leader: recomputing the whole
                      // roster keeps the crown from briefly appearing twice.
                      onSlotsChanged(
                        slots.map((s) => ({ ...s, role: s.id === next ? 'leader' : 'member' })),
                      )
                    }, 'Could not change the leader')
                  }
                >
                  <Crown size={12} />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title="Remove slot"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await removeSlotAction({ workspaceId, workspaceSlug, teamId, slotId: slot.id })
                      onSlotsChanged(slots.filter((s) => s.id !== slot.id))
                    }, 'Could not remove the slot')
                  }
                >
                  <Trash2 size={12} />
                </Button>
              </li>
            )
          })}
        </ul>
        {slots.length === 0 && (
          <p className="text-xs text-black/40 dark:text-white/40">No slots yet.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Select
          value={addingAgentId == null ? '' : String(addingAgentId)}
          onValueChange={(v) => {
            const id = Number(v)
            setAddingAgentId(id)
            // Pre-fill with a name that already disambiguates a repeat, so
            // adding the same agent twice never produces two identical rows.
            const agent = agents.find((a) => a.id === id)
            const sameAgent = slots.filter((s) => s.agentId === id).length
            setDisplayName(agent ? (sameAgent === 0 ? agent.name : `${agent.name} ${sameAgent + 1}`) : '')
          }}
          disabled={busy || agents.length === 0}
        >
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue placeholder="Add an agent as a slot…" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={String(agent.id)}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {addingAgentId != null && (
          <div className="space-y-1.5">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="What this slot is called"
              className="h-7 text-xs"
              disabled={busy}
            />
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="xs"
                disabled={busy || !displayName.trim()}
                onClick={() =>
                  void run(async () => {
                    const member = await addSlotAction({
                      workspaceId,
                      workspaceSlug,
                      teamId,
                      agentId: addingAgentId,
                      displayName,
                    })
                    onSlotsChanged([
                      ...slots,
                      { ...member, agentName: agents.find((a) => a.id === member.agentId)?.name ?? null },
                    ])
                    setAddingAgentId(null)
                    setDisplayName('')
                  }, 'Could not add the slot')
                }
              >
                <UserPlus size={12} />
                Add slot
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAddingAgentId(null)
                  setDisplayName('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="pt-1">
        {/*
          The dead-letter queue (R6.6). The feed already strikes through an
          undelivered message where it sits, but the feed is a capped window;
          this is how somebody asks "did anything get lost when I removed that
          member?" months later and gets a real answer.
        */}
        {deadLetters == null ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setDeadLetters(await listTeamDeadLettersAction({ workspaceId, teamId }))
              }, 'Could not read the dead-letter queue')
            }
          >
            <MailX size={12} />
            Undelivered mail
          </Button>
        ) : (
          <div className="rounded-lg border border-black/10 p-2 dark:border-white/10">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-xs font-medium">
                {deadLetters.length} undelivered
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => setDeadLetters(null)}
              >
                Hide
              </Button>
            </div>
            {deadLetters.length === 0 ? (
              <p className="text-[11px] text-black/40 dark:text-white/40">
                Nothing was lost. Every directed message reached a slot that still exists.
              </p>
            ) : (
              <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                {deadLetters.map((message) => (
                  <li key={message.id} className="text-[11px]">
                    <p className="text-red-600 dark:text-red-400">{message.undeliverableReason}</p>
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-black/55 dark:text-white/55">
                      {message.body}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="mt-auto pt-2">
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await deleteTeamAction({ workspaceId, workspaceSlug, teamId })
              router.push(`/workspace/${workspaceSlug}/teams`)
            }, 'Could not delete the team')
          }
        >
          Delete team
        </Button>
        <p className="mt-1 text-[11px] text-black/35 dark:text-white/35">
          Deleting a team removes its slots, mailbox and board. The slots&apos; conversations survive in Work.
          Removing a single slot hands its unfinished tasks back to the board and marks any unread mail addressed
          to it undeliverable — those messages are not broadcast to the rest of the room.
        </p>
      </div>
    </aside>
  )
}
