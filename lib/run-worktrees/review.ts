// ROADMAP P6.4 — the single surface the review route/actions call through,
// composing this project's own config (`./config.ts`), naming scheme
// (`./manager.ts`'s `describeRunWorktree`), and read/write primitives
// (`./diff.ts`, `./merge.ts`). Neither the route nor the server actions
// construct a `RunWorktree` by hand — always through `locateRunWorktree`,
// so there's exactly one place that decides where a given run's branch and
// worktree live.
import { describeRunWorktree, type RunWorktree } from './manager'
import { resolveRunWorktreeConfig } from './config'
import { getChangedFiles, getFileDiff, getWorktreeState, type ChangedFile, type WorktreeState } from './diff'
import { mergeRunBranch, type MergeRunBranchResult } from './merge'

export function locateRunWorktree(runId: number): RunWorktree {
  const { source, rootDir, baseBranch } = resolveRunWorktreeConfig()
  return describeRunWorktree(rootDir, source, String(runId), baseBranch)
}

export interface RunReviewSnapshot {
  worktree: RunWorktree
  state: WorktreeState
  files: ChangedFile[]
}

/**
 * Everything the review page needs for one run. `state.branchExists` is
 * false — not thrown — for any run nothing has actually dispatched through
 * `RunWorktreeManager` yet (the common case until Pillar 4's dispatcher is
 * wired to call `.create()`); callers render that as a clear "nothing to
 * review yet" state, not an error page.
 */
export async function loadRunReview(runId: number): Promise<RunReviewSnapshot> {
  const worktree = locateRunWorktree(runId)
  const state = await getWorktreeState(worktree)
  const files = state.branchExists ? await getChangedFiles(worktree) : []
  return { worktree, state, files }
}

export async function loadFileDiff(runId: number, path: string): Promise<{ patch: string; file: ChangedFile | null }> {
  const worktree = locateRunWorktree(runId)
  const files = await getChangedFiles(worktree)
  const file = files.find((f) => f.path === path) ?? null
  if (!file) return { patch: '', file: null }
  const patch = await getFileDiff(worktree, file)
  return { patch, file }
}

export async function approveMerge(runId: number): Promise<MergeRunBranchResult> {
  const worktree = locateRunWorktree(runId)
  const { source, baseBranch, rootDir } = resolveRunWorktreeConfig()
  return mergeRunBranch(worktree, { sourceRepo: source, baseBranch, rootDir })
}
