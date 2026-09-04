import type { TeamMember, TeamMessageKind, TeamTask, TeamTaskStatus } from '@/lib/broker'
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

/** A slot plus the one thing the roster cannot derive on the client: which
 * agent is behind it. Denormalised once on the server rather than one lookup
 * per lane. */
export interface TeamSlotView extends TeamMember {
  agentName: string | null
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

export const MESSAGE_KIND_LABEL: Record<TeamMessageKind, string> = {
  instruction: 'instruction',
  report: 'report',
  question: 'question',
  answer: 'answer',
  status: 'status',
}

/** Kind is the feed's only affordance for skimming, so the five kinds have to
 * be distinguishable at a glance without reading the body. Border colour, not
 * fill: a wall of filled chips is louder than the messages themselves. */
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
export function senderLabelForMessage(slots: TeamSlotView[], message: TeamRoomMessage): string {
  if (message.systemKind) return 'Room'
  return senderLabel(slots, message.fromSlotId)
}

export function recipientLabel(slots: TeamSlotView[], toSlotId: number | null): string {
  if (toSlotId == null) return 'everyone'
  return slotById(slots, toSlotId)?.displayName ?? `a removed member (slot ${toSlotId})`
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
