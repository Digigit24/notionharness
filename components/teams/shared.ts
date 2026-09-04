import type { TeamMember, TeamMessageKind, TeamTask, TeamTaskStatus } from '@/lib/broker'

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
 * `from_slot_id IS NULL` means either "the human said this" or "the slot that
 * said it has since been deleted", because the column is ON DELETE SET NULL.
 * The two are genuinely indistinguishable in the current schema, so this
 * returns the human label and the ambiguity is stated in the channel's own
 * footnote instead of being hidden behind a confident name.
 */
export function senderLabel(slots: TeamSlotView[], fromSlotId: number | null): string {
  return slotById(slots, fromSlotId)?.displayName ?? 'You'
}

export function recipientLabel(slots: TeamSlotView[], toSlotId: number | null): string {
  return slotById(slots, toSlotId)?.displayName ?? 'everyone'
}

/** The tasks a slot is carrying right now — the only member state this app can
 * report truthfully today (see the presence note in `lanes-view.tsx`). */
export function tasksForSlot(tasks: TeamTask[], slotId: number): TeamTask[] {
  return tasks.filter((t) => t.ownerSlotId === slotId)
}
