import type {
  ChannelMessage,
  MentionTarget,
  TeamMessageKind,
  TeamRole,
  TeamTask,
  TeamTaskStatus,
} from '@/lib/broker'
// A value import, and safe on both sides: `lib/broker/types.ts` is a pure
// declaration file whose only import is `import type`, so nothing from the
// driver reaches the browser bundle through it.
import { TERMINAL_STATUSES, type RunStatus } from '@/lib/broker/types'
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
  /**
   * R12-P3.1 - client-only, and absent on every row the server sent.
   *
   * A message you have just written exists on screen before it exists in the
   * database. `pendingKey` is how the real row that comes back is matched to
   * the placeholder it replaces - the id cannot do that, because the
   * placeholder has no real id yet and that is the entire point.
   */
  pendingKey?: string
  /** `'sending'` while the write is in flight, `'failed'` if it was refused.
   * Absent means this row is what the database holds. */
  sendState?: 'sending' | 'failed'
  /** Why it was refused, for the row to show and for a retry to make sense. */
  failureMessage?: string
}

/**
 * Where an unsent message sorts.
 *
 * The feed is ordered by id ascending, so a placeholder needs an id ABOVE
 * every real one to sit at the bottom where it was typed - a negative
 * sentinel, the obvious choice, would put your own message at the top of the
 * channel. Successive placeholders increment, so two messages sent in the same
 * second keep the order they were typed in.
 */
export const OPTIMISTIC_ID_BASE = Number.MAX_SAFE_INTEGER - 1_000_000

let optimisticCounter = 0

/**
 * The row that appears the instant Enter is pressed.
 *
 * D0: "No round trip on the send path. Pressing Enter paints immediately.
 * Anything the server has to confirm is confirmed after the paint, never
 * before it." The composer used to await the server before clearing itself,
 * which on a warm local database looks fine and over a real network is the
 * difference between chat and a form.
 *
 * Everything the server will fill in is left in its empty state rather than
 * guessed: no reactions, no replies, no task. The one field that is a guess is
 * `createdAt`, and it is corrected the moment the real row lands.
 */
export function makeOptimisticMessage(input: {
  teamId: number
  fromSlotId: number | null
  toSlotId: number | null
  kind: TeamMessageKind
  body: string
  threadRootId: number | null
  mentions: MentionTarget[]
  /** R14-P0.4 — Media ids already uploaded by the time `send()` runs, so the
   * chip/preview the composer showed BEFORE Enter is what paints in the
   * placeholder row too, rather than the attachment appearing to vanish until
   * the real row lands. Optional and defaulted to `[]`: every pre-P0.4 caller
   * of this function keeps compiling with no attachments, same migration
   * posture `lib/failures.ts`'s own header describes for `WithFailure`. */
  attachments?: number[]
}): RoomFeedMessage {
  optimisticCounter += 1
  return {
    id: OPTIMISTIC_ID_BASE + optimisticCounter,
    teamId: input.teamId,
    fromSlotId: input.fromSlotId,
    toSlotId: input.toSlotId,
    kind: input.kind,
    body: input.body,
    taskId: null,
    createdAt: new Date().toISOString(),
    threadRootId: input.threadRootId,
    mentions: input.mentions,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    undeliverableReason: null,
    runId: null,
    attachments: input.attachments ?? [],
    systemKind: null,
    undeliverableAt: null,
    addresseeMissing: false,
    pendingKey: `pending-${optimisticCounter}-${Date.now()}`,
    sendState: 'sending',
  }
}

/** True for a row that has not been written yet. Used to keep placeholders out
 * of anything that addresses a message BY ID on the server - reactions, thread
 * opens, task creation - none of which can work against an id that does not
 * exist yet. */
export function isOptimistic(message: RoomFeedMessage): boolean {
  return message.pendingKey != null
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
 * Who a message names, resolved on the client for the optimistic row.
 *
 * The SERVER's `parseMentions` remains the one that decides who is actually
 * woken - this changes nothing about that, and it deliberately does not try
 * to. It exists because the row appears before the server has answered, and a
 * message whose `@Claude Code` lights up half a second late looks like the
 * mention did not register.
 *
 * It reuses `splitMentions` rather than re-deriving the matching rules, so the
 * highlight in the row and the index behind it cannot disagree about what
 * counts as a mention - including the prefix rule, where `@Bob 2` must not
 * also match `@Bob`.
 */
export function parseMentionsLocally(
  body: string,
  roster: Array<{ id: number; displayName: string }>,
): MentionTarget[] {
  const seen = new Set<number>()
  const targets: MentionTarget[] = []
  for (const segment of splitMentions(body, roster)) {
    if (segment.mentionSlotId == null || seen.has(segment.mentionSlotId)) continue
    seen.add(segment.mentionSlotId)
    targets.push({ type: 'slot', id: segment.mentionSlotId })
  }
  return targets
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

// --- A mention that starts work (this unit) ----------------------------------

/**
 * The run a channel message started, as `getRunsForChannelMessages` answers it.
 *
 * Keyed by the message that NAMED the agent — `runs.channel_message_id`
 * (migration 0014) points at the trigger, not at the answer. That asymmetry is
 * the single most important thing to know about this whole feature and it is
 * why `runLinkFor` below has two cases rather than one.
 */
export interface ChannelRunLink {
  runId: number
  sessionId: number | null
  status: string
}

/** Terminal in the run table's own vocabulary. Duplicated as a predicate
 * rather than re-deriving from timestamps: the status column is the fact. */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as RunStatus)
}

/**
 * Where "See full run" points for a given message.
 *
 * TWO cases, and the second one is a compromise that is stated rather than
 * hidden:
 *
 *  1. The message that named the agent HAS a run row against it, so the link
 *     is exact — that run, in that session.
 *  2. An agent's REPLY has no run row of its own. `team_messages` carries no
 *     `run_id` — that column now EXISTS. A message written by an agent, whether
 *     the dispatcher posted it as a backstop or the agent posted it itself
 *     with `team_send_message`, carries the run that wrote it, so a reply
 *     links to its exact transcript. The old fallback to the slot's session
 *     stays for messages written before the column existed, and says so.
 *
 * Returns null when there is nothing honest to link to — a person's message,
 * or an agent slot that has no session yet.
 */
export function runLinkFor(
  message: { id: number; fromSlotId: number | null; runId?: number | null },
  runs: Map<number, ChannelRunLink>,
  slots: TeamSlotView[],
): { sessionId: number; exact: boolean; runId?: number } | null {
  // The message's OWN run, when it has one. This is the exact answer and it
  // beats both cases below.
  if (message.runId != null) {
    const own = runs.get(message.id)
    const sessionId = own?.sessionId ?? slotById(slots, message.fromSlotId)?.sessionId ?? null
    if (sessionId != null) return { sessionId, exact: true, runId: message.runId }
  }
  const direct = runs.get(message.id)
  if (direct?.sessionId != null) return { sessionId: direct.sessionId, exact: true }
  const from = slotById(slots, message.fromSlotId)
  if (from && from.agentId != null && from.sessionId != null) {
    return { sessionId: from.sessionId, exact: false }
  }
  return null
}

/**
 * An agent that was woken and has not answered yet — the "replying…" row.
 *
 * Held per RUN rather than per message: one message can name two agents, and
 * two ghosts under one line is the correct picture of what is happening.
 */
export interface PendingReply {
  /** The message that named the agent. The ghost renders under this row. */
  messageId: number
  /** The thread the answer will land in — the trigger's root, or itself. */
  threadRootId: number
  slotId: number
  displayName: string
  runId: number
  sessionId: number | null
  /**
   * `replyCount` on the thread root at the moment this ghost appeared.
   *
   * The answer arrives as a THREAD REPLY, which the feed never contains (the
   * feed is roots only), so "has it answered yet" cannot be asked of the feed
   * rows directly. The root's reply count is the one signal that does travel
   * with the feed, and it is the database's own count rather than anything
   * this client tallies.
   */
  baselineReplyCount: number
}

/** A mention that deliberately woke nobody, with the reason the server gave. */
export interface SkippedMention {
  messageId: number
  slotId: number
  displayName: string
  reason: string
}

// --- Slash commands ----------------------------------------------------------

export interface SlashCommandSpec {
  name: string
  /** Rendered after the name in the palette, e.g. "@member subject". */
  args: string
  hint: string
}

/**
 * The four commands, and nothing invented.
 *
 * Every one of them is a call this room already makes: `/task` and `/assign`
 * are `createTeamTaskAction`, `/canvas` is the header's own Canvas toggle, and
 * `/status` prints the health and board numbers the room is already holding —
 * it deliberately does NOT post anything, because a status line typed into the
 * feed is a message somebody then has to read past.
 */
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: 'task', args: '<subject>', hint: 'Open a task on the board' },
  { name: 'assign', args: '@member <subject>', hint: 'Open a task already owned by a member' },
  { name: 'canvas', args: '', hint: "Open the channel's canvas" },
  { name: 'status', args: '', hint: 'Who is working, and what is claimable' },
]

/**
 * The command being typed, if the composer holds one.
 *
 * Position 0 ONLY. A "/" anywhere else is a path, a date or a fraction, and
 * the mention scanner made the same call about "@" for the same reason.
 * `complete` is true once a separator has been typed, which is what tells the
 * palette to stop filtering and start showing the one command in play.
 */
export function slashCommandAt(value: string): { name: string; rest: string; complete: boolean } | null {
  if (!value.startsWith('/')) return null
  const firstLine = value.slice(1)
  const match = /^([a-zA-Z]*)([\s\S]*)$/.exec(firstLine)
  if (!match) return null
  const [, name, remainder] = match
  return { name: name.toLowerCase(), rest: remainder.trimStart(), complete: remainder.length > 0 }
}

/** The subject line a message becomes when it is turned into a task: the first
 * non-empty line, capped. The rest of the body becomes the description, so
 * nothing is lost by the split. */
export function subjectFromBody(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? body
  const clean = line.trim().replace(/\s+/g, ' ')
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean
}

/** The task a message is about, resolved for the inline chip. Null rather
 * than a placeholder when the task has been deleted out from under the
 * message — a chip for a task that is not on the board would be a link to
 * nowhere. */
export function taskChipFor(
  tasks: TeamTask[],
  slots: TeamSlotView[],
  taskId: number | null,
): { id: number; subject: string; status: TeamTaskStatus; ownerName: string | null; ownerColour: string | null } | null {
  if (taskId == null) return null
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null
  const owner = slotById(slots, task.ownerSlotId)
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ownerName: owner?.displayName ?? null,
    ownerColour: owner ? colourOf(owner) : null,
  }
}
