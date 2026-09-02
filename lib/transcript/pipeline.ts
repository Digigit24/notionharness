/**
 * Pipeline composer — wires the four pure passes together.
 *
 *   envelopes
 *     → buildTimeline          (sort, dedupe, coalesce, redact, project)
 *     → surfaceOrphanCalls     (mark tool_calls whose results never arrived)
 *     → buildSteps             (pair tool_call ↔ tool_result by id)
 *     → buildGroups            (fold ≥3 same-name non-shell runs)
 *     → buildLanesAndOutcome   (tool vs thinking timeline + header chips)
 *
 * Each intermediate result is also returned, so callers can compose
 * their own pipelines on top of any single pass without re-running the
 * earlier ones. The default `processTranscript` call is the all-in-one
 * shortcut that the chat UI will use.
 */

import type { RunEventEnvelope } from '../run-events'
import { buildLanesAndOutcome, type LaneSegment, type OutcomeSummary } from './lanes'
import { buildGroups, type GroupedStep } from './groups'
import { buildSteps, type Step } from './steps'
import { buildTimeline, surfaceOrphanCalls, type TimelineItem } from './timeline'

export interface TranscriptResult {
  timeline: TimelineItem[]
  steps: Step[]
  groupedSteps: GroupedStep[]
  lanes: LaneSegment[]
  outcome: OutcomeSummary
}

/**
 * Run all four passes over a raw envelope stream.
 *
 * Pure: no I/O, no global state. Safe to call from React server
 * components, Node scripts, or future worker threads alike.
 */
export function processTranscript(envelopes: readonly RunEventEnvelope[]): TranscriptResult {
  const rawTimeline = buildTimeline(envelopes)
  const timeline = surfaceOrphanCalls(rawTimeline)
  const steps = buildSteps(timeline)
  const groupedSteps = buildGroups(steps)
  const { lanes, outcome } = buildLanesAndOutcome(timeline, steps, groupedSteps)
  return { timeline, steps, groupedSteps, lanes, outcome }
}

/** Re-export every pass so callers can build their own compositions. */
export { buildTimeline, surfaceOrphanCalls } from './timeline'
export type {
  TimelineItem,
  TimelineItemKind,
  MessageTimelineItem,
  ThoughtTimelineItem,
  ToolCallTimelineItem,
  OrphanToolCallTimelineItem,
  ToolResultTimelineItem,
  PermissionTimelineItem,
  FileChangeTimelineItem,
  TerminalTimelineItem,
  UsageTimelineItem,
  SessionTimelineItem,
  DoneTimelineItem,
} from './timeline'
export { buildSteps, surfaceOrphanResults } from './steps'
export type { Step } from './steps'
export { buildGroups } from './groups'
export type { GroupedStep, CollapsedGroup } from './groups'
export { buildLanesAndOutcome } from './lanes'
export type { LaneKind, LaneSegment, OutcomeSummary } from './lanes'
export { SECRET_PATTERNS, formatCostUSD, redactSecretsInValue, applyReplacements } from './_util'
