// R3.4 — reclaiming per-run worktrees without destroying a review someone is
// still reading.
//
// Every dispatched run cuts a fresh checkout of the source repo under
// `<root>/runs/<runId>`, and nothing has ever removed one. The reason was
// sound: the review screen reads a run's diff out of its worktree, so
// deleting on settle would empty the very screen the run exists to produce.
// The consequence was a directory that grows by a full checkout per run,
// forever.
//
// So this is a retention policy rather than a cleanup. Three reasons to keep
// a worktree, and a worktree is removed only when none of them applies:
//
//   1. Its run has not finished. Deleting the ground under a running agent
//      is not garbage collection.
//   2. Its review is still open — the run produced a page subtree whose
//      suggestion is still `pending` and undismissed. That is precisely the
//      case the original "never delete" rule was protecting.
//   3. It is among the most recent N settled runs. Recency is what makes
//      "let me look at what just happened" work without ceremony.
//
// Removal goes through `RunWorktreeManager.remove`, so git's own registration
// is pruned and the run branch deleted rather than leaving a repo full of
// dangling worktree entries.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { getBrokerPool } from '@/lib/broker/db'
import { RunWorktreeManager, describeRunWorktree } from './manager'

/** How many settled runs keep their checkout purely for convenience. */
const DEFAULT_KEEP_LAST = 20

export interface ReclaimOptions {
  rootDir: string
  source: string
  keepLast?: number
  /** R12-P5.2's disk budget. When the settled, review-closed checkouts this
   * function is willing to touch at all still add up to more than this many
   * bytes after `keepLast` has already been applied, the oldest of the ones
   * `keepLast` would otherwise have spared are removed too — oldest first —
   * until the total is back under budget. Never applied to `unfinished` or
   * `open-review` checkouts: a disk budget is a reason to reclaim sooner, not
   * a reason to delete the ground under a running agent or a review someone
   * has not looked at yet. Unset (the default) means no budget — `keepLast`
   * alone decides, exactly as before this option existed. */
  maxTotalBytes?: number
  /** Report what would happen without touching anything. */
  dryRun?: boolean
}

export interface ReclaimReport {
  /** Worktree directories found on disk. */
  examined: number
  /** Run ids whose checkout was removed. */
  removed: string[]
  /** Of `removed`, the ones removed because `maxTotalBytes` was exceeded
   * rather than because they fell outside `keepLast` — named separately so a
   * log line (P5.6) can say WHY, not just how many. */
  budgetEvicted: string[]
  /** Run ids kept, with the reason — a report nobody can act on is not a report. */
  kept: Array<{ runId: string; reason: 'unfinished' | 'open-review' | 'recent' | 'unknown-run' }>
  /** Approximate bytes freed, summed from the directories actually removed. */
  reclaimedBytes: number
  /** Total bytes still held by every checkout this pass decided to KEEP —
   * what a `maxTotalBytes` budget is actually being measured against. */
  keptBytes: number
  failures: Array<{ runId: string; error: string }>
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // Vanished mid-walk; it is not being counted, which is correct.
        }
      }
    }
  }
  return total
}

export async function reclaimRunWorktrees(options: ReclaimOptions): Promise<ReclaimReport> {
  const keepLast = options.keepLast ?? DEFAULT_KEEP_LAST
  const runsDir = join(options.rootDir, 'runs')

  const report: ReclaimReport = {
    examined: 0,
    removed: [],
    budgetEvicted: [],
    kept: [],
    reclaimedBytes: 0,
    keptBytes: 0,
    failures: [],
  }

  let entries
  try {
    entries = await readdir(runsDir, { withFileTypes: true })
  } catch {
    // Nothing has ever run here. Not an error.
    return report
  }
  const onDisk = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  report.examined = onDisk.length
  if (onDisk.length === 0) return report

  // Every id on disk was a run id, but only numeric ones correspond to rows
  // in `runs` — anything else came from a test or an older scheme and is not
  // this function's business to guess about.
  const numericIds = onDisk.map(Number).filter((n) => Number.isFinite(n))
  const pool = getBrokerPool()
  const { rows } = await pool.query<{
    id: number
    status: string
    suggestion_status: string
    dismissed_at: Date | null
    page_subtree_block_id: string | null
  }>(
    `SELECT id, status, suggestion_status, dismissed_at, page_subtree_block_id
       FROM runs
      WHERE id = ANY($1::int[])`,
    [numericIds],
  )
  const byId = new Map(rows.map((r) => [String(r.id), r]))

  // Recency is decided by run id, which is monotonic — not by directory
  // mtime, which a review that merely READ the worktree could have bumped.
  const recentOrder = [...numericIds].sort((a, b) => b - a).map(String)
  const recent = new Set(recentOrder.slice(0, keepLast))

  const manager = new RunWorktreeManager({ rootDir: options.rootDir })

  // Phase 1 — classify every checkout, exactly as before `maxTotalBytes`
  // existed: `unfinished` and `open-review` are never touched by ANYTHING in
  // this function (not `keepLast`, not a budget); a `keepLast`-eligible
  // "recent" checkout is provisionally kept but, unlike the first two
  // reasons, is a candidate the budget phase below is allowed to evict.
  const removable: string[] = []
  const provisionallyRecent: string[] = []
  for (const runId of onDisk) {
    const run = byId.get(runId)
    if (!run) {
      // A checkout whose run row is gone. Left alone deliberately: this
      // function reclaims space, it does not adjudicate orphans it cannot
      // explain, and a wrong deletion here is unrecoverable. (The orphan
      // REAPER, `manager.ts`'s `reapOrphanedWorktrees`, is the one thing
      // that does adjudicate this — for branches, not worktree directories.)
      report.kept.push({ runId, reason: 'unknown-run' })
      continue
    }
    const settled = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    if (!settled) {
      report.kept.push({ runId, reason: 'unfinished' })
      continue
    }
    const reviewOpen =
      run.page_subtree_block_id !== null && run.suggestion_status === 'pending' && run.dismissed_at === null
    if (reviewOpen) {
      report.kept.push({ runId, reason: 'open-review' })
      continue
    }
    if (recent.has(runId)) {
      provisionallyRecent.push(runId)
      continue
    }
    removable.push(runId)
  }

  // Phase 2 — the disk budget (P5.2). Only meaningful once every entry falling
  // outside `keepLast` is already accounted for as `removable`: the budget
  // asks "even after keepLast, are we still over?", oldest-of-the-kept first.
  // `recentSizes` is kept around (not just the eviction set) so phase 3 can
  // report `keptBytes` without walking these same directories a second time.
  //
  // `onDisk`'s own order is whatever `readdir` returned — filesystem order,
  // not recency — so `provisionallyRecent` is re-sorted newest-first here
  // before anything below relies on that order to find "oldest of the kept".
  provisionallyRecent.sort((a, b) => Number(b) - Number(a))
  const recentSizes = new Map<string, number>()
  const budgetEvictions = new Set<string>()
  if (provisionallyRecent.length > 0) {
    for (const runId of provisionallyRecent) {
      const worktree = describeRunWorktree(options.rootDir, options.source, runId)
      recentSizes.set(runId, await directorySize(worktree.worktreePath))
    }
    if (options.maxTotalBytes !== undefined) {
      let total = [...recentSizes.values()].reduce((sum, size) => sum + size, 0)
      // `provisionallyRecent` was sorted newest-first above, so evicting
      // from the END walks oldest-first — the checkouts someone is least
      // likely to still be looking at.
      for (let i = provisionallyRecent.length - 1; i >= 0 && total > options.maxTotalBytes; i -= 1) {
        const runId = provisionallyRecent[i]
        budgetEvictions.add(runId)
        total -= recentSizes.get(runId) ?? 0
      }
    }
  }

  for (const runId of provisionallyRecent) {
    if (budgetEvictions.has(runId)) {
      removable.push(runId)
    } else {
      report.kept.push({ runId, reason: 'recent' })
      report.keptBytes += recentSizes.get(runId) ?? 0
    }
  }

  // Phase 3 — act. `keptBytes` is computed alongside removal so a caller can
  // see, in the same report, what the budget is actually being measured
  // against — a number that is otherwise invisible until the NEXT pass finds
  // it still over budget.
  for (const runId of removable) {
    const worktree = describeRunWorktree(options.rootDir, options.source, runId)
    const size = recentSizes.has(runId) ? (recentSizes.get(runId) as number) : await directorySize(worktree.worktreePath)
    if (options.dryRun) {
      report.removed.push(runId)
      if (budgetEvictions.has(runId)) report.budgetEvicted.push(runId)
      report.reclaimedBytes += size
      continue
    }
    try {
      // `discardChanges` because this run is settled and its review is
      // closed: whatever is uncommitted in there has already been accepted,
      // rejected or dismissed, and git will otherwise refuse to remove it.
      // `manager.remove` itself logs what it discards with real content
      // (P5.6) — this function does not need to repeat that here.
      await manager.remove(worktree, { discardChanges: true })
      report.removed.push(runId)
      if (budgetEvictions.has(runId)) report.budgetEvicted.push(runId)
      report.reclaimedBytes += size
    } catch (err) {
      report.failures.push({ runId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
