/**
 * Pass 4 — Lanes + Outcome.
 *
 * Two outputs in one pass:
 *
 * 1. `lanes: LaneSegment[]` — a two-lane (tool / thinking) timeline
 *    bar data structure. Each segment is `{ lane, startSeq, endSeq,
 *    label? }` where the seq range is the duration of that activity.
 *    Tool segments come from Steps (start = tool_call.seq, end =
 *    tool_result.seq if present else tool_call.endSeq). Thinking
 *    segments come from `thought` TimelineItems (a single seq point,
 *    expanded to a minimal 1-seq segment for visualisation).
 *
 * 2. `outcome: OutcomeSummary` — the four header chips the roadmap
 *    calls out, plus the numeric breakdowns they render from:
 *      - filesChanged    (distinct file_change.path count)
 *      - linesAdded      (sum of `+` lines across all file_change.diffs)
 *      - linesRemoved    (sum of `-` lines across all file_change.diffs)
 *      - commandsCount   (count of Steps whose name is shell-like)
 *      - totalCostTicks  (sum of usage.costTicks)
 *    Plus the pre-formatted strings the header UI displays:
 *      - filesChip       e.g. "11 files +593 −12"
 *      - commandsChip    e.g. "74 commands" (or "1 command" / "no commands")
 *      - costChip        e.g. "$4.38" (or "$0.00")
 *
 * Diff parsing is intentionally minimal — we count lines that start
 * with `+` or `-` (after stripping the leading character), ignoring
 * `+++`/`---` file headers (the `+++`/`---` lines are recognised as
 * headers and excluded). This matches what most diff UIs display.
 */

import { formatCostUSD } from './_util'
import type { TimelineItem } from './timeline'
import type { Step } from './steps'
import type { GroupedStep } from './groups'

export type LaneKind = 'tool' | 'thinking'

export interface LaneSegment {
  lane: LaneKind
  startSeq: number
  endSeq: number
  /** Optional label — tool name for tool segments, undefined for thinking. */
  label?: string
}

export interface OutcomeSummary {
  /** Distinct paths touched by `file_change` events. */
  filesChanged: number
  /** `+` lines summed across all diffs (excluding `+++` file headers). */
  linesAdded: number
  /** `-` lines summed across all diffs (excluding `---` file headers). */
  linesRemoved: number
  /** Number of Steps with a shell-like name (never collapsed). */
  commandsCount: number
  /** Sum of all `usage.costTicks` values. */
  totalCostTicks: number
  /** Pre-formatted header chip strings (UI-friendly). */
  chips: {
    files: string
    commands: string
    cost: string
  }
}

/** Diff line counting — recognise unified diff `+`/`-` line prefixes
 *  but skip `+++`/`---` file headers (which begin with two of the same
 *  sign character). */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.length === 0) continue
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) continue
    if (rawLine.startsWith('+')) added++
    else if (rawLine.startsWith('-')) removed++
  }
  return { added, removed }
}

/** Detects the same "shell-ish" names the Groups pass protects. We
 *  re-declare the regex here (the public `groups` API doesn't expose it)
 *  so this module stays self-contained. Keep in sync with
 *  `groups.ts::SHELL_NAME_RE`. */
const SHELL_NAME_RE = /\b(?:bash|sh|zsh|fish|powershell|pwsh|cmd|run_command|exec_command|shell|run_shell|terminal_command)\b/i

export function buildLanesAndOutcome(
  timeline: readonly TimelineItem[],
  steps: readonly Step[],
  groupedSteps?: readonly GroupedStep[],
): { lanes: LaneSegment[]; outcome: OutcomeSummary } {
  // --- Lanes ----------------------------------------------------------
  const lanes: LaneSegment[] = []

  for (const step of steps) {
    lanes.push({
      lane: 'tool',
      startSeq: step.startSeq,
      endSeq: Math.max(step.endSeq, step.startSeq + 1),
      label: step.name,
    })
  }

  for (const item of timeline) {
    if (item.kind === 'thought') {
      lanes.push({
        lane: 'thinking',
        startSeq: item.seq,
        endSeq: item.seq + 1,
      })
    }
  }

  // Stable sort by startSeq, then by lane ('tool' first so the tool bar
  // visually sits above thinking in the timeline).
  lanes.sort((a, b) => {
    if (a.startSeq !== b.startSeq) return a.startSeq - b.startSeq
    if (a.lane !== b.lane) return a.lane === 'tool' ? -1 : 1
    return 0
  })

  // --- Outcome --------------------------------------------------------
  const changedPaths = new Set<string>()
  let linesAdded = 0
  let linesRemoved = 0
  for (const item of timeline) {
    if (item.kind === 'file_change') {
      changedPaths.add(item.path)
      const counts = countDiffLines(item.diff)
      linesAdded += counts.added
      linesRemoved += counts.removed
    }
  }

  // Commands count: shell-named Steps, regardless of grouping. We use
  // the raw Step[] (not GroupedStep[]) so a collapsed-group of e.g.
  // 12 read_file calls doesn't double-count, and so a run of 5 distinct
  // bash calls counts as 5 even though they live as individual Steps
  // (the Groups pass never folds shell names).
  let commandsCount = 0
  for (const step of steps) {
    if (SHELL_NAME_RE.test(step.name)) commandsCount++
  }

  let totalCostTicks = 0
  for (const item of timeline) {
    if (item.kind === 'usage') totalCostTicks += item.costTicks
  }

  const outcome: OutcomeSummary = {
    filesChanged: changedPaths.size,
    linesAdded,
    linesRemoved,
    commandsCount,
    totalCostTicks,
    chips: {
      files:
        changedPaths.size === 0
          ? 'no files'
          : `${changedPaths.size} file${changedPaths.size === 1 ? '' : 's'} +${linesAdded} −${linesRemoved}`,
      commands:
        commandsCount === 0
          ? 'no commands'
          : `${commandsCount} command${commandsCount === 1 ? '' : 's'}`,
      cost: formatCostUSD(totalCostTicks),
    },
  }

  // `groupedSteps` is accepted for forward compatibility — Pass 5+
  // (e.g. a transcript-export pass) may want to know which Steps got
  // collapsed. We don't read it here today; the parameter keeps the
  // call shape future-proof without forcing this module to depend on
  // the Groups pass output.
  void groupedSteps

  return { lanes, outcome }
}
