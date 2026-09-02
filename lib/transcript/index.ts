/**
 * Re-export the entire transcript pipeline through one barrel.
 *
 * Most consumers should import `processTranscript` from here and not
 * reach into the individual pass modules — that keeps the seam between
 * the four passes owned by the pipeline composer.
 */

export {
  processTranscript,
  buildTimeline,
  surfaceOrphanCalls,
  buildSteps,
  surfaceOrphanResults,
  buildGroups,
  buildLanesAndOutcome,
  SECRET_PATTERNS,
  formatCostUSD,
  redactSecretsInValue,
  applyReplacements,
} from './pipeline'

export type {
  TranscriptResult,
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
  Step,
  GroupedStep,
  CollapsedGroup,
  LaneKind,
  LaneSegment,
  OutcomeSummary,
} from './pipeline'
