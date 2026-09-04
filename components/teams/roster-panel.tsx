'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Crown, MailX, PanelRightClose, PanelRightOpen, Trash2, User, UserPlus } from 'lucide-react'
import type { TeamTask } from '@/lib/broker'
import type { TeamRoomMessage, TeamSlotHealth } from '@/lib/teams/reliability'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { unwrap } from '@/lib/failures'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  SLOT_STATE_CLASS,
  SLOT_STATE_DOT,
  SLOT_STATE_LABEL,
  colourOf,
  formatSilence,
  healthBySlot,
  initialsOf,
  tasksForSlot,
  type TeamAgentOption,
  type TeamSlotView,
  type TeamUserOption,
} from './shared'
import {
  addSlotAction,
  deleteTeamAction,
  listTeamDeadLettersAction,
  removeSlotAction,
  setLeaderAction,
} from '@/app/(app)/workspace/[workspaceSlug]/teams/actions'
import { ChannelInviteByEmail } from '@/components/members/channel-invite'

/** What the "add" picker is currently offering. Two lists, one control: a
 * channel gains members of both kinds and splitting it into two pickers would
 * make adding a person feel like a different feature from adding an agent. */
type AddKind = 'agent' | 'user'

/**
 * Where the open/closed choice is remembered.
 *
 * Per browser, not per channel: "do I want the roster taking 15rem" is a
 * preference about the layout, not about one room, and having it reset every
 * time you walk into a different channel would make it feel broken.
 *
 * localStorage rather than a column on the user: a preference this cheap must
 * never cost a request to read or a request to write (D0), and it is read
 * during hydration where a round trip would be a visible reflow.
 */
const ROSTER_OPEN_KEY = 'notionharness.channel.roster.open'

/**
 * The roster: who is in the channel, who leads, and how to change that.
 *
 * Present in all three views rather than hidden behind a settings screen,
 * because membership is the thing you adjust while watching the room work —
 * a member that turns out to be redundant, or a leader that needs replacing.
 *
 * TWO rules this panel exists to honour.
 *
 * A SLOT IS NOT AN AGENT. Adding the same agent twice produces two slots with
 * two jobs, two threads and two colours, so the picker deliberately never
 * disables an agent already in the roster and nothing here deduplicates by
 * agent id. That is R6.1's model, and it is the thing a naive implementation
 * gets wrong.
 *
 * A MEMBER IS NOT NECESSARILY AN AGENT. Migration 0013 made `agent_id`
 * nullable and added `user_id` with a CHECK that exactly one is set, so a
 * person holds a slot the same way an agent does — and everything downstream
 * (tasks, mentions, reactions, unread) already spoke slots, so nothing else
 * had to change.
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
  channelName,
  slots,
  mySlotId,
  tasks,
  health,
  agents,
  users,
  onSlotsChanged,
}: {
  workspaceId: number
  workspaceSlug: string
  teamId: number
  /** The channel's own name, for the invitation copy — "they land in #design"
   * is the sentence somebody needs before they hand a stranger a link.
   * Optional so a caller that has not been updated still compiles and still
   * works; the copy degrades to "this channel" rather than the panel
   * disappearing. */
  channelName?: string
  slots: TeamSlotView[]
  mySlotId: number | null
  tasks: TeamTask[]
  health: TeamSlotHealth[]
  agents: TeamAgentOption[]
  users: TeamUserOption[]
  onSlotsChanged: (slots: TeamSlotView[]) => void
}) {
  const router = useRouter()
  const healthOf = healthBySlot(health)
  const [addKind, setAddKind] = useState<AddKind>('agent')
  const [addingId, setAddingId] = useState<number | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * Shut by default, so the conversation gets the width.
   *
   * The roster is a control surface — who is in the room, who leads — and it
   * is consulted far less often than the thread beside it is read. Rendering
   * it collapsed on the server and opening it in an effect (rather than
   * reading storage in the initial state) keeps the markup the server sent and
   * the markup the client hydrates identical; the reverse would be a
   * hydration mismatch on every load.
   */
  const [collapsed, setCollapsed] = useState(true)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ROSTER_OPEN_KEY) === 'open') setCollapsed(false)
    } catch {
      // A browser with storage blocked simply gets the default.
    }
  }, [])
  const setOpen = (open: boolean) => {
    setCollapsed(!open)
    try {
      window.localStorage.setItem(ROSTER_OPEN_KEY, open ? 'open' : 'closed')
    } catch {
      // Remembering is a nicety; toggling must work either way.
    }
  }
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

  function pick(kind: AddKind, id: number) {
    setAddKind(kind)
    setAddingId(id)
    if (kind === 'agent') {
      // Pre-fill with a name that already disambiguates a repeat, so adding
      // the same agent twice never produces two identical rows.
      const agent = agents.find((a) => a.id === id)
      const sameAgent = slots.filter((s) => s.agentId === id).length
      setDisplayName(agent ? (sameAgent === 0 ? agent.name : `${agent.name} ${sameAgent + 1}`) : '')
    } else {
      setDisplayName(users.find((u) => u.id === id)?.name ?? '')
    }
  }

  // A person can hold only one slot per channel: `resolveMySlot` picks the
  // lowest id, so a second slot for the same person would be a row that can
  // never be spoken from. Agents have no such limit — that is the point.
  const alreadyMembers = new Set(slots.map((s) => s.userId).filter((id): id is number => id != null))
  const addableUsers = users.filter((u) => !alreadyMembers.has(u.id))

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center gap-1.5 overflow-y-auto pt-0.5">
        <button
          type="button"
          title={`Members · ${slots.length} — show the roster`}
          onClick={() => setOpen(true)}
          className="rounded p-1 text-black/45 hover:bg-black/[.06] hover:text-black/70 dark:text-white/45 dark:hover:bg-white/[.10] dark:hover:text-white/70"
        >
          <PanelRightOpen size={14} />
        </button>
        {/* The rail is not decoration: liveness is the one thing on this panel
            that changes while you are reading, so a lost member still shows a
            red ring with the roster shut. */}
        {slots.map((slot) => {
          const state = healthOf.get(slot.id)
          return (
            <button
              key={slot.id}
              type="button"
              onClick={() => setOpen(true)}
              title={`${slot.displayName}${state ? ` — ${SLOT_STATE_LABEL[state.state]}` : ''}`}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white',
                state?.state === 'lost' && 'ring-2 ring-red-500/70',
              )}
              style={{ backgroundColor: colourOf(slot) }}
            >
              {initialsOf(slot.displayName)}
            </button>
          )
        })}
      </aside>
    )
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto">
      <div>
        <h2 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-black/50 dark:text-white/50">
          <span className="flex-1">Members · {slots.length}</span>
          <button
            type="button"
            title="Hide the roster and give the width back to the conversation"
            onClick={() => setOpen(false)}
            className="rounded p-0.5 hover:bg-black/[.06] dark:hover:bg-white/[.10]"
          >
            <PanelRightClose size={13} />
          </button>
        </h2>
        <ul className="space-y-1">
          {slots.map((slot) => {
            const owned = tasksForSlot(tasks, slot.id)
            const state = healthOf.get(slot.id)
            const isPerson = slot.userId != null
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
                  className="flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                  style={{ backgroundColor: colourOf(slot) }}
                >
                  {initialsOf(slot.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="min-w-0 truncate text-sm">{slot.displayName}</span>
                    {slot.id === mySlotId && (
                      <span className="shrink-0 text-[10px] text-black/35 dark:text-white/35">you</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1 truncate text-[11px] text-black/40 dark:text-white/40">
                    {isPerson ? <User size={10} aria-hidden /> : <Bot size={10} aria-hidden />}
                    <span className="truncate">
                      {isPerson
                        ? (slot.userName ?? 'a person')
                        : (slot.agentName ?? `agent ${slot.agentId ?? '?'}`)}
                    </span>
                    {owned.length > 0 && <span className="shrink-0">· {owned.length} assigned</span>}
                  </span>
                  {/* The heartbeat, in the row it describes. Only agent slots
                      have one: liveness is derived from a slot's RUNS, and a
                      person has none — printing "idle" against a colleague
                      would be a machine's judgement of a human, from evidence
                      that does not exist. */}
                  {state && !isPerson && (
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
                  title={slot.role === 'leader' ? 'Leads this channel — click to clear' : 'Make leader'}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = slot.role === 'leader' ? null : slot.id
                      unwrap(await setLeaderAction({ workspaceId, workspaceSlug, teamId, slotId: next }))
                      // Applied locally as well as revalidated, because at
                      // most one row can be leader: recomputing the whole
                      // roster keeps the crown from briefly appearing twice.
                      onSlotsChanged(slots.map((s) => ({ ...s, role: s.id === next ? 'leader' : 'member' })))
                    }, 'Could not change the leader')
                  }
                >
                  <Crown size={12} />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title="Remove from channel"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      onSlotsChanged(
                        unwrap(await removeSlotAction({ workspaceId, workspaceSlug, teamId, slotId: slot.id })),
                      )
                    }, 'Could not remove the member')
                  }
                >
                  <Trash2 size={12} />
                </Button>
              </li>
            )
          })}
        </ul>
        {slots.length === 0 && <p className="text-xs text-black/40 dark:text-white/40">Nobody is in this channel.</p>}
      </div>

      <div className="space-y-1.5">
        <Select
          // Reset to no value after each pick so the SAME agent can be chosen
          // again immediately. A controlled Select that keeps the last value
          // would swallow the second click on that agent, which is the one
          // interaction slots exist for.
          value=""
          onValueChange={(v) => {
            const [kind, raw] = v.split(':')
            pick(kind === 'user' ? 'user' : 'agent', Number(raw))
          }}
          disabled={busy || (agents.length === 0 && addableUsers.length === 0)}
        >
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue placeholder="Add a member…" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={`agent-${agent.id}`} value={`agent:${agent.id}`}>
                {agent.name}
              </SelectItem>
            ))}
            {addableUsers.map((person) => (
              <SelectItem key={`user-${person.id}`} value={`user:${person.id}`}>
                {person.name} · person
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/*
          THE OTHER HALF OF "ADD A MEMBER".
          The picker above offers people who are already in this workspace,
          because adding one of them is a `team_members` row and nothing more.
          Somebody who is NOT in the workspace cannot be added that way at all —
          there is no user id to put in the row, and there may be no account —
          so they are invited by email with this channel carried on the
          invitation, and the accept path puts them in both at once. Two
          operations wearing one label is how the second one goes missing.
        */}
        <ChannelInviteByEmail
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          teamId={teamId}
          channelName={channelName ?? 'this channel'}
        />

        {addingId != null && (
          <div className="space-y-1.5">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={addKind === 'agent' ? 'What this slot is called' : 'How this person appears here'}
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
                    onSlotsChanged(
                      unwrap(
                        await addSlotAction({
                          workspaceId,
                          workspaceSlug,
                          teamId,
                          agentId: addKind === 'agent' ? addingId : null,
                          userId: addKind === 'user' ? addingId : null,
                          displayName,
                        }),
                      ),
                    )
                    setAddingId(null)
                    setDisplayName('')
                  }, 'Could not add the member')
                }
              >
                <UserPlus size={12} />
                Add
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAddingId(null)
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
                setDeadLetters(unwrap(await listTeamDeadLettersAction({ workspaceId, teamId })))
              }, 'Could not read the dead-letter queue')
            }
          >
            <MailX size={12} />
            Undelivered mail
          </Button>
        ) : (
          <div className="rounded-lg border border-black/10 p-2 dark:border-white/10">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-xs font-medium">{deadLetters.length} undelivered</span>
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
              unwrap(await deleteTeamAction({ workspaceId, workspaceSlug, teamId }))
              router.push(`/workspace/${workspaceSlug}/teams`)
            }, 'Could not delete the channel')
          }
        >
          Delete channel
        </Button>
        <p className="mt-1 text-[11px] text-black/35 dark:text-white/35">
          Deleting a channel removes its members, messages and board. Agent slots&apos; conversations survive in
          Work. Removing a single member hands its unfinished tasks back to the board and marks any unread mail
          addressed to it undeliverable — those messages are not broadcast to the rest of the room.
        </p>
      </div>
    </aside>
  )
}
