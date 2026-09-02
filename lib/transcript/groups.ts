/**
 * Pass 3 — Groups.
 *
 * Input:  Step[] (post Pass 2).
 * Output: GroupedStep[] — Steps in their original order, except that
 *         runs of ≥3 consecutive Steps with the same `name` (and where
 *         that name does NOT look like a shell/command invocation)
 *         are folded into a single CollapsedGroup entry.
 *
 * Why shell/bash is exempt: each invocation is meaningful on its own
 * (different flags, different exit code, different downstream effect).
 * Folding five `bash` calls into one row would hide a real bug.
 *
 * Group identity: `name` is the only key — we deliberately do NOT
 * compare input shapes, since two `read_file` calls with different
 * paths are still semantically "the same read_file group" from the UI's
 * perspective. The representative Step carries one example; the count
 * field tells the UI how many to expect.
 */

import type { Step } from './steps'

export interface CollapsedGroup {
  kind: 'collapsed'
  /** Stable identifier — UI keys and "expand all" affordances pin to this. */
  groupId: string
  name: string
  count: number
  /** First Step in the collapsed run — provides input/output/status preview. */
  representative: Step
  /** Indices into the original Steps[] (for "expand all" deep-linking). */
  memberIndices: number[]
  startSeq: number
  endSeq: number
}

export type GroupedStep = Step | CollapsedGroup

const MIN_GROUP_SIZE = 3

/**
 * Heuristic for "this name is a shell-ish tool that should never be
 * collapsed". Lower-cased, anchored on whole-word match so `bashful`
 * or `reshell` aren't accidentally exempted.
 *
 * Names we know are agent shell invocations: bash, sh, zsh, fish,
 * powershell, pwsh, cmd, run_command, exec_command, shell, run_shell,
 * terminal_command. ACP tools with names like `run_command` are common.
 */
const SHELL_NAME_RE = /\b(?:bash|sh|zsh|fish|powershell|pwsh|cmd|run_command|exec_command|shell|run_shell|terminal_command)\b/i

function isShellLike(name: string): boolean {
  return SHELL_NAME_RE.test(name)
}

export function buildGroups(steps: readonly Step[]): GroupedStep[] {
  const out: GroupedStep[] = []
  let runStart = 0
  let groupIdCounter = 0

  const flushRun = (runEndExclusive: number) => {
    const runLength = runEndExclusive - runStart
    if (runLength <= 0) return
    const representative = steps[runStart]
    if (runLength < MIN_GROUP_SIZE || isShellLike(representative.name)) {
      // Emit individually.
      for (let i = runStart; i < runEndExclusive; i++) {
        out.push(steps[i])
      }
      return
    }
    // Collapse.
    const memberIndices = Array.from({ length: runLength }, (_, i) => runStart + i)
    const lastStep = steps[runEndExclusive - 1]
    out.push({
      kind: 'collapsed',
      groupId: `g${groupIdCounter++}`,
      name: representative.name,
      count: runLength,
      representative,
      memberIndices,
      startSeq: representative.startSeq,
      endSeq: lastStep.endSeq,
    })
  }

  for (let i = 1; i <= steps.length; i++) {
    const sameNameAsStart = i < steps.length && steps[i].name === steps[runStart].name
    if (!sameNameAsStart) {
      flushRun(i)
      runStart = i
    }
  }

  return out
}
