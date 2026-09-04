import type { ChannelMessage, TeamMessageKind, TeamRole, TeamTask, TeamTaskStatus } from '@/lib/broker'
// `import type` and nothing else: `lib/teams/reliability.ts` pulls in `pg` and
// `node:crypto`, and this module is imported by client components. Types are
// erased at compile time, so nothing from it reaches the browser bundle.
import type { TeamRoomMessage, TeamSlotHealth, TeamSlotState } from '@/lib/teams/reliability'

/**
 * Types and constants shared by the Teams route and its client components.
 *
 * Deliberately NOT marked `'use client'`: the server actions file imports
 * `slotColourFor` from here, and a client module imported from a server module
 * pulls a client boundary into a place that has no business having one.
 * Everything below is plain data and pure functions, so both sides can use it.
 */

/**
 * A member slot as the UI needs it.
 *
 * No longer `extends TeamMember`, and that is the point. Migration 0013 made
 * `team_members.agent_id` nullable and added `user_id`, with a CHECK that
 * exactly one is set — so a slot is backed by an agent OR by a person.
 * `lib/broker/teams.ts`'s own mapper still types `agentId` as `number` and
 * would render a human slot's NULL as agent `0`; that file belongs to the
 * foundation and is not edited here, so this unit reads slots with its own
 * query (`loadSlots` in the route's `actions.ts`) and this is the shape it
 * returns.
 */
export interface TeamSlotView {
  id: number
  teamId: number
  /** Null for a human slot. */
  agentId: number | null
  /** Null for an agent slot. A Payload `users` id. */
  userId: number | null
  role: TeamRole
  displayName: string
  colour: string | null
  sessionId: number | null
  worktreeId: number | null
  /** Resolved once on the server rather than one lookup per lane. Null when
   * the agent was deleted out from under the slot. */
  agentName: string | null
  /** The person's name, for a human slot. */
  userName: string | null
  /** Per-member unread high-water mark (0013). Only meaningful for the
   * viewer's own slot, which is the only one the room reads it for. */
  lastReadMessageId: number | null
}

/** The agents (and, since 0013, the people) a channel can be built out of. */
export interface TeamAgentOption {
  id: number
  name: string
}

export interface TeamUserOption {
  id: number
  name: string
  email: string
}

/**
 * The channel feed's row: `ChannelMessage` (threads, mentions, reactions) plus
 * the three reliability facts `lib/broker/channels.ts` does not carry.
 *
 * Two sources rather than one because neither query can answer for the other:
 * `listChannelFeed` knows about reply counts and reactions, `listTeamRoomMessages`
 * knows which rows the room wrote itself and which directed notes died. They
 * are joined by id in the server action, not per row in the browser.
 */
export interface RoomFeedMessage extends ChannelMessage {
  /** 'slot_lost' | 'slot_recovered' | 'room_stop' | 'dead_letter', or null for
   * a row a person or a slot actually wrote. */
  systemKind: string | null
  undeliverableAt: string | null
  addresseeMissing: boolean
}

/**
 * Slot colours, stored on the row at creation time.
 *
 * Eight, then it wraps. A ninth slot repeating the first colour is a legible
 * failure — two lanes that look alike — where generating a colour from the
 * slot id would be an illegible one, producing muddy and occasionally
 * unreadable values against both themes.
 */
export const SLOT_COLOURS = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#0ea5e9',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
] as const

export function slotColourFor(index: number): string {
  return SLOT_COLOURS[index % SLOT_COLOURS.length]
}

/** Falls back to a neutral rather than inventing a colour, so a slot created
 * by something other than this UI (an MCP call, a seed) still renders. */
export function colourOf(slot: { colour: string | null } | null | undefined): string {
  return slot?.colour ?? '#64748b'
}

/**
 * The one or two letters on an avatar.
 *
 * First letters of the first two words, so "Review Bot" reads "RB" and "Coder"
 * reads "C". Deliberately not the first two characters of one word: "Co" and
 * "Cr" are far harder to tell apart at 28px than "C" and "CR".
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export const MESSAGE_KIND_LABEL: Record<TeamMessageKind, string> = {
  instruction: 'instruction',
  report: 'report',
  question: 'question',
  answer: 'answer',
  status: 'status',
}

/** Kind is the feed's only affordance for skimming, so the five kinds have to
 * be distinguishable at a glance without reading the body. Border colour, not
 * fill: a wall of filled chips is louder than the messages themselves.
 *
 * `status` is the default a plain chat message carries, and the channel view
 * therefore does NOT print a chip for it — see `MessageRow`. A chip on every
 * single line is noise, and Slack has no such thing. */
export const MESSAGE_KIND_CLASS: Record<TeamMessageKind, string> = {
  instruction: 'border-indigo-500/40 text-indigo-600 dark:text-indigo-400',
  report: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  question: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  answer: 'border-sky-500/40 text-sky-600 dark:text-sky-400',
  status: 'border-black/15 text-black/50 dark:border-white/15 dark:text-white/50',
}

export const TASK_STATUS_LABEL: Record<TeamTaskStatus, string> = {
  open: 'Open',
  claimed: 'Claimed',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** Board column order. `cancelled` is last and deliberately still shown:
 * a task someone killed is a fact about the run, and hiding it makes the
 * board disagree with the feed, which still carries its messages. */
export const BOARD_COLUMNS: TeamTaskStatus[] = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled']

export const TASK_STATUS_CLASS: Record<TeamTaskStatus, string> = {
  open: 'text-black/60 dark:text-white/60',
  claimed: 'text-sky-600 dark:text-sky-400',
  in_progress: 'text-indigo-600 dark:text-indigo-400',
  blocked: 'text-amber-600 dark:text-amber-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  cancelled: 'text-black/40 line-through dark:text-white/40',
}

export function slotById(slots: TeamSlotView[], id: number | null): TeamSlotView | null {
  if (id == null) return null
  return slots.find((s) => s.id === id) ?? null
}

/**
 * Who a message is from, in the feed's terms.
 *
 * Three cases now, where there used to be two badly-merged ones. `from_slot_id`
 * used to be ON DELETE SET NULL, so a departed member's messages became
 * indistinguishable from the human's and every one of them was printed as
 * "You". Migration 0012 dropped that FK action, so a removed slot keeps its id
 * and this can finally say what actually happened.
 *
 * A dangling id (non-null, no matching roster row) is a member that has left.
 * Only a genuinely NULL sender is the human — and, since 0012, only when the
 * row carries no `system_kind`; see `senderLabelForMessage`.
 */
export function senderLabel(slots: TeamSlotView[], fromSlotId: number | null): string {
  if (fromSlotId == null) return 'You'
  return slotById(slots, fromSlotId)?.displayName ?? 'a removed member'
}

/** The room itself is the third speaker: rows written by the reliability sweep
 * and the stop action, which are neither a person nor a slot. */
export function senderLabelForMessage(
  slots: TeamSlotView[],
  message: { fromSlotId: number | null; systemKind?: string | null },
): string {
  if (message.systemKind) return 'Room'
  return senderLabel(slots, message.fromSlotId)
}

export function recipientLabel(slots: TeamSlotView[], toSlotId: number | null): string {
  if (toSlotId == null) return 'everyone'
  return slotById(slots, toSlotId)?.displayName ?? `a removed member (slot ${toSlotId})`
}

// --- The channel feed --------------------------------------------------------

/**
 * Emoji the picker offers.
 *
 * A fixed short list, not a full emoji keyboard. A picker is a two-second
 * interaction and the long tail is served by nobody: Slack's own most-used set
 * is roughly this. Adding a search-and-scroll grid would mean either a
 * dependency this unit may not install or a hand-written 1800-entry table, and
 * neither earns its place next to a message.
 */
export const REACTION_CHOICES = ['👍', '🎉', '👀', '✅', '🔥', '🙏', '😄', '🤔'] as const

/** How long a gap ends a run of messages from one author. Slack uses five
 * minutes; long enough that a burst of typing stays one block, short enough
 * that "and another thing, an hour later" gets its own header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

/** Identity of the speaker, for grouping. A system row never groups with
 * anything (it is the room talking, not a person), and neither does a
 * directed note with a different addressee — "→ Reviewer" is part of the
 * header, so hiding the header would hide who it was for. */
function speakerKey(message: RoomFeedMessage): string {
  if (message.systemKind) return `system:${message.id}`
  return `${message.fromSlotId ?? 'human'}:${message.toSlotId ?? 'all'}:${message.kind}`
}

/** True when `message` should be drawn as a continuation of `previous` —
 * body only, no avatar, no name, no timestamp. */
export function isGroupedWith(previous: RoomFeedMessage | null, message: RoomFeedMessage): boolean {
  if (!previous) return false
  if (speakerKey(previous) !== speakerKey(message)) return false
  if (dayKeyOf(previous.createdAt) !== dayKeyOf(message.createdAt)) return false
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt)
  return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS
}

/** Local calendar day, as a sortable key. Local rather than UTC because the
 * divider says "Today" to the person reading it, not to the server. */
export function dayKeyOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function formatDayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown date'
  if (dayKeyOf(iso) === dayKeyOf(new Date(now).toISOString())) return 'Today'
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  if (dayKeyOf(iso) === dayKeyOf(yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Wall-clock time, which is what a chat client shows beside a name. The
 * relative form ("3 minutes ago") is kept for the channel list and for thread
 * summaries, where the exact minute is not the useful part. */
export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export interface BodySegment {
  text: string
  /** The slot this run of text mentions, when it is a mention. */
  mentionSlotId: number | null
}

/**
 * Splits a body into plain runs and `@name` runs, for rendering only.
 *
 * Longest display name first, case-insensitively — the same ordering
 * `parseMentions` in `lib/broker/channels.ts` uses, so "@Coder 2" is never
 * eaten by "@Coder". The body text is never rewritten; this is a view over it.
 *
 * KNOWN DIVERGENCE FROM THE SERVER, found by testing the two against each
 * other and left in place deliberately rather than matched.
 *
 * `parseMentions` asks `body.includes('@' + name)` for every roster entry
 * INDEPENDENTLY, so it does not consume what it matches: the text "@Coder 2"
 * contains the substring "@Coder", and the stored index therefore names BOTH
 * slots. This function consumes each match, so it highlights one mention —
 * of "Coder 2", which is what the text actually says.
 *
 * Reproducing the server's behaviour here would mean drawing a highlight
 * around "@Coder" inside "@Coder 2", which is visibly wrong, so the renderer
 * stays strict. The consequence, stated plainly: an agent whose name is a
 * PREFIX of another member's gets a mention badge for messages that do not
 * visibly name it. That is a bug in `parseMentions` — it needs to consume
 * matches the way this does — and `lib/broker/channels.ts` is foundation that
 * this unit does not edit, so it is reported rather than worked around.
 *
 * Row-level "this mentions me" (`mentionsSlot`) reads the STORED index, not
 * this function, so the badge and the row highlight always agree with the
 * database even while the inline highlight is stricter than it.
 */
export function splitMentions(
  body: string,
  roster: Array<{ id: number; displayName: string }>,
): BodySegment[] {
  const ordered = [...roster]
    .filter((m) => m.displayName.trim().length > 0)
    .sort((a, b) => b.displayName.length - a.displayName.length)
  if (ordered.length === 0) return [{ text: body, mentionSlotId: null }]

  const lower = body.toLowerCase()
  const segments: BodySegment[] = []
  let cursor = 0
  let plainStart = 0

  outer: while (cursor < body.length) {
    if (body[cursor] === '@') {
      for (const member of ordered) {
        const needle = `@${member.displayName}`.toLowerCase()
        if (lower.startsWith(needle, cursor)) {
          if (cursor > plainStart) segments.push({ text: body.slice(plainStart, cursor), mentionSlotId: null })
          segments.push({ text: body.slice(cursor, cursor + needle.length), mentionSlotId: member.id })
          cursor += needle.length
          plainStart = cursor
          continue outer
        }
      }
    }
    cursor += 1
  }
  if (plainStart < body.length) segments.push({ text: body.slice(plainStart), mentionSlotId: null })
  return segments
}

/**
 * The reaction list a message should show once a toggle has landed.
 *
 * Pure, and shared by the feed and the thread pane, so the two cannot drift
 * into disagreeing about the same message. `toggleReaction` already returns
 * `added` and the actor's slot id, which is precisely enough to recompute the
 * row without asking the server for it again — the round trip D0 forbids on a
 * UI action.
 */
export function applyReactionToggle(
  reactions: ChannelMessage['reactions'],
  emoji: string,
  actorSlotId: number,
  added: boolean,
): ChannelMessage['reactions'] {
  if (added) {
    const existing = reactions.find((r) => r.emoji === emoji)
    if (!existing) return [...reactions, { emoji, count: 1, actorSlotIds: [actorSlotId] }]
    // Guarded against a double-add: the unique index makes a second identical
    // reaction impossible in the database, so counting it twice here would put
    // the UI a number ahead of the truth until the next poll.
    if (existing.actorSlotIds.includes(actorSlotId)) return reactions
    return reactions.map((r) =>
      r.emoji === emoji ? { ...r, count: r.count + 1, actorSlotIds: [...r.actorSlotIds, actorSlotId] } : r,
    )
  }
  return reactions
    .map((r) =>
      r.emoji === emoji
        ? { ...r, count: r.count - 1, actorSlotIds: r.actorSlotIds.filter((id) => id !== actorSlotId) }
        : r,
    )
    .filter((r) => r.count > 0)
}

/** True when this message names the given slot. Reads the STORED index rather
 * than re-scanning the body, so a display-name change cannot silently move a
 * mention from one member to another. */
export function mentionsSlot(message: { mentions: Array<{ type: string; id: number }> }, slotId: number | null): boolean {
  if (slotId == null) return false
  return message.mentions.some((m) => m.type === 'slot' && m.id === slotId)
}

// --- Reliability (R6.6) ------------------------------------------------------

/** Deliberately plain words, not jargon. A person reading a roster needs to
 * know whether to wait, to intervene, or to do nothing. */
export const SLOT_STATE_LABEL: Record<TeamSlotState, string> = {
  lost: 'lost',
  awaiting_approval: 'waiting on you',
  awaiting_directory: 'waiting on a directory',
  running: 'working',
  queued: 'queued',
  silent: 'quiet',
  idle: 'idle',
}

/**
 * Colour carries the urgency, and only two states get a loud one.
 *
 * `lost` is red because work was taken off a member and put back on the board.
 * `awaiting_approval` is amber because a person is the blocker and nothing
 * moves until they act. Everything else is deliberately quiet: a roster where
 * every row is coloured tells you nothing, which is the failure R6.6 names —
 * a lost slot that looks like a working one is not reliability, and neither is
 * a working one that looks alarming.
 */
export const SLOT_STATE_CLASS: Record<TeamSlotState, string> = {
  lost: 'text-red-600 dark:text-red-400',
  awaiting_approval: 'text-amber-600 dark:text-amber-400',
  awaiting_directory: 'text-amber-600 dark:text-amber-400',
  running: 'text-indigo-600 dark:text-indigo-400',
  queued: 'text-black/45 dark:text-white/45',
  silent: 'text-amber-600/80 dark:text-amber-400/80',
  idle: 'text-black/40 dark:text-white/40',
}

/** The dot beside a name, so state is readable without reading the word. */
export const SLOT_STATE_DOT: Record<TeamSlotState, string> = {
  lost: 'bg-red-500',
  awaiting_approval: 'bg-amber-500',
  awaiting_directory: 'bg-amber-500',
  running: 'bg-indigo-500',
  queued: 'bg-black/25 dark:bg-white/25',
  silent: 'bg-amber-400',
  idle: 'bg-black/20 dark:bg-white/20',
}

export function healthBySlot(health: TeamSlotHealth[]): Map<number, TeamSlotHealth> {
  return new Map(health.map((h) => [h.slotId, h]))
}

/** Silence, in the coarsest unit that is still true. "quiet 4m" is what a
 * person can act on; "quiet 247s" is a number they then have to divide. */
export function formatSilence(ms: number | null): string {
  if (ms == null) return 'never seen'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** The tasks a slot is carrying right now — the only member state this app can
 * report truthfully today (see the presence note in `lanes-view.tsx`). */
export function tasksForSlot(tasks: TeamTask[], slotId: number): TeamTask[] {
  return tasks.filter((t) => t.ownerSlotId === slotId)
}

/** Kept so `lanes-view.tsx` can keep taking the reliability row shape it was
 * written against while the channel reads the richer feed row. */
export type { TeamRoomMessage }
