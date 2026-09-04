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
  /** Report what would happen without touching anything. */
  dryRun?: boolean
}

export interface ReclaimReport {
  /** Worktree directories found on disk. */
  examined: number
  /** Run ids whose checkout was removed. */
  removed: string[]
  /** Run ids kept, with the reason — a report nobody can act on is not a report. */
  kept: Array<{ runId: string; reason: 'unfinished' | 'open-review' | 'recent' | 'unknown-run' }>
  /** Approximate bytes freed, summed from the directories actually removed. */
  reclaimedBytes: number
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

  const report: ReclaimReport = { examined: 0, removed: [], kept: [], reclaimedBytes: 0, failures: [] }

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
  const recent = new Set(
    [...numericIds]
      .sort((a, b) => b - a)
      .slice(0, keepLast)
      .map(String),
  )

  const manager = new RunWorktreeManager({ rootDir: options.rootDir })

  for (const runId of onDisk) {
    const run = byId.get(runId)
    if (!run) {
      // A checkout whose run row is gone. Left alone deliberately: this
      // function reclaims space, it does not adjudicate orphans it cannot
      // explain, and a wrong deletion here is unrecoverable.
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
      report.kept.push({ runId, reason: 'recent' })
      continue
    }

    const worktree = describeRunWorktree(options.rootDir, options.source, runId)
    const size = await directorySize(worktree.worktreePath)
    if (options.dryRun) {
      report.removed.push(runId)
      report.reclaimedBytes += size
      continue
    }
    try {
      // `discardChanges` because this run is settled and its review is
      // closed: whatever is uncommitted in there has already been accepted,
      // rejected or dismissed, and git will otherwise refuse to remove it.
      await manager.remove(worktree, { discardChanges: true })
      report.removed.push(runId)
      report.reclaimedBytes += size
    } catch (err) {
      report.failures.push({ runId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
