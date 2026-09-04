/**
 * Pass 1 — Timeline.
 *
 * Input:  RunEventEnvelope[] — the raw event stream from the broker/daemon.
 *         May be out of order (the roadmap explicitly warns that batched
 *         inserts return unordered and ordering by timestamp/insertion
 *         scrambles transcripts).
 * Output: TimelineItem[] — a single linear timeline, ready for the Steps
 *         pass to pair tool_call ↔ tool_result over.
 *
 * Transformations, in order:
 *   1. Stable sort by `seq` ascending.
 *   2. Drop envelopes whose seq is duplicated (keep the first seen) —
 *      malformed input tolerance, doesn't violate the broker's contract.
 *   3. Coalesce adjacent message events with the same role into one item
 *      whose `text` is the concatenation of their texts. (Adjacent means
 *      there's no non-message event between them in the sorted order —
 *      thought/tool_call/etc. all break the coalescing run.)
 *   4. Redact secrets in any string-typed field of any event (see
 *      `_util.ts`).
 *   5. Project each event into a `TimelineItem` discriminator. tool_call
 *      events whose matching tool_result hasn't arrived yet in the
 *      envelope stream are emitted as `orphan_tool_call` so the UI can
 *      render a "still running" placeholder — the brief explicitly
 *      requires unpaired tool_calls to be handled, not dropped.
 */

import type { RunEvent, RunEventEnvelope } from '../run-events'
import { redactSecretsInValue } from './_util'

/** Discriminator for a timeline item. */
export type TimelineItemKind =
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'orphan_tool_call'
  | 'tool_result'
  | 'permission'
  | 'file_change'
  | 'terminal'
  | 'usage'
  | 'session'
  | 'done'

export interface TimelineItemBase {
  /** First seq that contributed to this item (already-redacted form). */
  seq: number
  /** Last seq that contributed (same as `seq` for everything except coalesced messages). */
  endSeq: number
  kind: TimelineItemKind
}

export interface MessageTimelineItem extends TimelineItemBase {
  kind: 'message'
  role: 'user' | 'assistant' | 'system'
  text: string
}

export interface ThoughtTimelineItem extends TimelineItemBase {
  kind: 'thought'
  text: string
}

export interface ToolCallTimelineItem extends TimelineItemBase {
  kind: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  output?: unknown
  isError?: boolean
}

export interface OrphanToolCallTimelineItem extends TimelineItemBase {
  kind: 'orphan_tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export interface ToolResultTimelineItem extends TimelineItemBase {
  kind: 'tool_result'
  id: string
  output: unknown
  isError: boolean
}

export interface PermissionTimelineItem extends TimelineItemBase {
  kind: 'permission'
  id: string
  title: string
  detail: string
  options: string[]
}

export interface FileChangeTimelineItem extends TimelineItemBase {
  kind: 'file_change'
  path: string
  diff: string
}

export interface TerminalTimelineItem extends TimelineItemBase {
  kind: 'terminal'
  id: string
  chunk: string
}

export interface UsageTimelineItem extends TimelineItemBase {
  kind: 'usage'
  provider: string
  model: string
  tokens: number
  costTicks: number
}

export interface SessionTimelineItem extends TimelineItemBase {
  kind: 'session'
  externalId: string
}

export interface DoneTimelineItem extends TimelineItemBase {
  kind: 'done'
  status: 'ok' | 'error' | 'cancelled'
  reason?: string
}

export type TimelineItem =
  | MessageTimelineItem
  | ThoughtTimelineItem
  | ToolCallTimelineItem
  | OrphanToolCallTimelineItem
  | ToolResultTimelineItem
  | PermissionTimelineItem
  | FileChangeTimelineItem
  | TerminalTimelineItem
  | UsageTimelineItem
  | SessionTimelineItem
  | DoneTimelineItem

/**
 * The set of `tool_call.status` values the ACP SDK legitimately emits. The
 * canonical RunEvent contract uses loose `string` (so unknown future
 * statuses pass through type-checking); we narrow here to the four states
 * the Steps/Groups/Lanes passes care about, falling back to `'pending'`
 * for anything else.
 */
const KNOWN_TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])

function normaliseToolStatus(s: string): ToolCallTimelineItem['status'] {
  return (KNOWN_TOOL_STATUSES.has(s) ? s : 'pending') as ToolCallTimelineItem['status']
}

/** Coerce any value into a plain object suitable for `tool_call.input`. */
function coerceInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

/** Coerce `tool_result.output` into something stable for the UI. */
function coerceOutput(raw: unknown): unknown {
  return redactSecretsInValue(raw)
}

/**
 * Stable sort by `seq` ascending. JavaScript's `Array.prototype.sort` is
 * stable since ES2019, so envelopes with identical seq keep their input
 * order; we use that to drop duplicate-seq envelopes deterministically
 * (first wins) before producing TimelineItems.
 */
export function buildTimeline(envelopes: readonly RunEventEnvelope[]): TimelineItem[] {
  if (envelopes.length === 0) return []

  // Sort copy.
  const sorted = [...envelopes].sort((a, b) => a.seq - b.seq)

  // Drop envelopes whose seq we've already seen (keep first).
  const seenSeq = new Set<number>()
  const unique: RunEventEnvelope[] = []
  for (const env of sorted) {
    if (seenSeq.has(env.seq)) continue
    seenSeq.add(env.seq)
    unique.push(env)
  }

  // Build a fast lookup of tool_call ids by seq so we can mark orphan
  // tool_results as belonging to a known call vs. as truly orphan.
  const toolCallIds = new Set<string>()
  for (const env of unique) {
    if (env.event.type === 'tool_call') toolCallIds.add(env.event.id)
  }

  // Walk in seq order, projecting each event into a TimelineItem and
  // coalescing adjacent messages with the same role into one item.
  const out: TimelineItem[] = []
  for (const env of unique) {
    const item = projectEvent(env.event, env.seq, toolCallIds)
    if (!item) continue
    const previous = out[out.length - 1]
    if (
      item.kind === 'message' &&
      previous &&
      previous.kind === 'message' &&
      previous.role === item.role
    ) {
      // Coalesce: append this item's text to the previous item's text.
      previous.text = previous.text + item.text
      previous.endSeq = item.seq
      continue
    }
    out.push(item)
  }
  return out
}

function projectEvent(
  event: RunEvent,
  seq: number,
  toolCallIds: Set<string>,
): TimelineItem | null {
  const redacted = redactSecretsInValue(event)
  switch (redacted.type) {
    case 'message':
      return {
        seq,
        endSeq: seq,
        kind: 'message',
        role: redacted.role,
        text: redacted.text,
      }
    case 'thought':
      return {
        seq,
        endSeq: seq,
        kind: 'thought',
        text: redacted.text,
      }
    case 'tool_call': {
      const status = normaliseToolStatus(redacted.status)
      return {
        seq,
        endSeq: seq,
        kind: 'tool_call',
        id: redacted.id,
        name: redacted.name,
        input: coerceInput(redacted.input),
        status,
      }
    }
    case 'tool_result': {
      // If we never saw the matching tool_call, surface the result as
      // an orphan tool_result (same kind, but the upstream pairing pass
      // will flag it).
      if (!toolCallIds.has(redacted.id)) {
        return {
          seq,
          endSeq: seq,
          kind: 'tool_result',
          id: redacted.id,
          output: coerceOutput(redacted.output),
          isError: redacted.isError,
        }
      }
      return {
        seq,
        endSeq: seq,
        kind: 'tool_result',
        id: redacted.id,
        output: coerceOutput(redacted.output),
        isError: redacted.isError,
      }
    }
    case 'permission':
      return {
        seq,
        endSeq: seq,
        kind: 'permission',
        id: redacted.id,
        title: redacted.title,
        detail: redacted.detail,
        options: redacted.options.map((option) => option.label ?? option.optionId),
      }
    case 'file_change':
      return {
        seq,
        endSeq: seq,
        kind: 'file_change',
        path: redacted.path,
        diff: redacted.diff,
      }
    case 'terminal':
      return {
        seq,
        endSeq: seq,
        kind: 'terminal',
        id: redacted.id,
        chunk: redacted.chunk,
      }
    case 'usage':
      return {
        seq,
        endSeq: seq,
        kind: 'usage',
        provider: redacted.provider,
        model: redacted.model,
        tokens: redacted.tokens,
        costTicks: redacted.costTicks,
      }
    case 'session':
      return {
        seq,
        endSeq: seq,
        kind: 'session',
        externalId: redacted.externalId,
      }
    case 'done':
      return {
        seq,
        endSeq: seq,
        kind: 'done',
        status: redacted.status,
        reason: redacted.reason,
      }
    default:
      return null
  }
}

/**
 * Pass 1b — surface tool_call items whose matching tool_result never
 * arrived as `orphan_tool_call` events. Run this AFTER `buildTimeline`:
 * it walks the timeline, and for any tool_call id that doesn't appear in
 * any tool_result item, emits an OrphanToolCallTimelineItem in the same
 * position. (This is split from buildTimeline so callers that don't need
 * orphan surfacing — e.g. real-time incremental rendering — can skip it.)
 */
export function surfaceOrphanCalls(timeline: readonly TimelineItem[]): TimelineItem[] {
  const resultIds = new Set<string>()
  for (const item of timeline) {
    if (item.kind === 'tool_result') resultIds.add(item.id)
  }
  return timeline.map((item) => {
    if (item.kind !== 'tool_call') return item
    if (resultIds.has(item.id)) return item
    const orphan: OrphanToolCallTimelineItem = {
      seq: item.seq,
      endSeq: item.endSeq,
      kind: 'orphan_tool_call',
      id: item.id,
      name: item.name,
      input: item.input,
      status: item.status,
    }
    return orphan
  })
}
