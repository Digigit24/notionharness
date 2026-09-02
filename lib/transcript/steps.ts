/**
 * Pass 2 — Steps.
 *
 * Input:  TimelineItem[] (post Pass 1).
 * Output: Step[] — one entry per *paired* tool invocation. Each Step
 *         carries the original tool_call input, the (possibly absent)
 *         tool_result output, a derived `status`, a `startSeq`/`endSeq`
 *         pair, and an `approxMsFromSeq` field used as a stand-in for
 *         wall-clock duration (the broker doesn't yet stamp envelopes
 *         with timestamps, and the roadmap explicitly says sequencing
 *         comes from `seq`, never from insertion order — so seq-distance
 *         is the only honest duration signal we have).
 *
 * Pairing algorithm:
 *   1. Walk timeline in order. For each `tool_call` item, record the
 *      call.
 *   2. For each `tool_result` item, attach it to the matching open call
 *      with the same id (last-unmatched call wins, since later updates
 *      on the same id supersede earlier ones).
 *   3. Orphan tool_calls (no matching result) become Steps with
 *      `output === undefined`, `isError === undefined`, and the same
 *      `status` the timeline recorded (typically `'in_progress'` for a
 *      still-running call).
 *   4. Orphan tool_results (a result with no preceding call) are
 *      ignored — they have nothing to attach to. Surfaced separately
 *      via `surfaceOrphanResults` if the UI needs them.
 *
 * Ordering: Steps are emitted in the order their `tool_call` first
 * appeared in the timeline. Within a collapsed run of same-id updates,
 * we emit ONE Step at the position of the earliest call.
 */

import type {
  OrphanToolCallTimelineItem,
  TimelineItem,
  ToolCallTimelineItem,
  ToolResultTimelineItem,
} from './timeline'

export interface Step {
  /** Discriminant so `GroupedStep = Step | CollapsedGroup` (Pass 3) can narrow. */
  kind: 'step'
  id: string
  name: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  input: Record<string, unknown>
  output?: unknown
  isError?: boolean
  startSeq: number
  endSeq: number
  /**
   * `seq` distance between the tool_call and its (eventual) tool_result.
   * NOT a wall-clock duration — the broker doesn't yet stamp envelopes
   * with timestamps. Consumers should scale/label this for display
   * (e.g. "about 5 events" rather than "5ms"). `undefined` if the result
   * never arrived (orphan call).
   */
  approxMsFromSeq?: number
}

/** Steps with the same `id` are the same call being updated; later wins. */
function deriveStepStatus(
  callStatus: ToolCallTimelineItem['status'] | OrphanToolCallTimelineItem['status'],
  resultStatus: 'completed' | 'failed' | undefined,
): Step['status'] {
  if (resultStatus === 'failed') return 'failed'
  if (resultStatus === 'completed') return 'completed'
  return callStatus === 'failed'
    ? 'failed'
    : callStatus === 'completed'
      ? 'completed'
      : callStatus === 'in_progress'
        ? 'in_progress'
        : 'pending'
}

export function buildSteps(timeline: readonly TimelineItem[]): Step[] {
  const openCalls = new Map<string, ToolCallTimelineItem | OrphanToolCallTimelineItem>()
  const pairedResults = new Map<string, ToolResultTimelineItem>()
  // Keep insertion order so steps render in the order their calls appeared.
  const callOrder: string[] = []

  for (const item of timeline) {
    if (item.kind === 'tool_call' || item.kind === 'orphan_tool_call') {
      // First-write-wins for the same id — keeps the earliest call's
      // startSeq even if the agent re-emits the same tool_call id later
      // (it shouldn't, but be defensive).
      if (!openCalls.has(item.id)) {
        openCalls.set(item.id, item)
        callOrder.push(item.id)
      }
    } else if (item.kind === 'tool_result') {
      // Last-result-wins for the same id.
      pairedResults.set(item.id, item)
    }
  }

  const steps: Step[] = []
  for (const id of callOrder) {
    const call = openCalls.get(id)!
    const result = pairedResults.get(id)
    const resultStatus = result ? (result.isError ? ('failed' as const) : ('completed' as const)) : undefined
    const status = deriveStepStatus(call.status, resultStatus)
    const step: Step = {
      kind: 'step',
      id,
      name: call.name,
      status,
      input: call.input,
      startSeq: call.seq,
      endSeq: result ? result.seq : call.endSeq,
    }
    if (result) {
      step.output = result.output
      step.isError = result.isError
      step.approxMsFromSeq = Math.max(0, result.seq - call.seq)
    }
    steps.push(step)
  }

  return steps
}

/**
 * Surface tool_results that arrived in the timeline without a matching
 * tool_call. The Steps pass drops these (they have nothing to attach
 * to); this helper makes them available so the UI can render them as
 * "result of an unknown call" if it wants. Most callers can ignore this.
 */
export function surfaceOrphanResults(timeline: readonly TimelineItem[]): ToolResultTimelineItem[] {
  const callIds = new Set<string>()
  for (const item of timeline) {
    if (item.kind === 'tool_call' || item.kind === 'orphan_tool_call') callIds.add(item.id)
  }
  const orphans: ToolResultTimelineItem[] = []
  for (const item of timeline) {
    if (item.kind === 'tool_result' && !callIds.has(item.id)) {
      orphans.push(item)
    }
  }
  return orphans
}
