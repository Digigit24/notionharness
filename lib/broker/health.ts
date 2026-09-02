import { getBrokerPool } from './db'

/**
 * ROADMAP B8.4 (Batch B-6 "Finish") — the internal health page's real
 * numbers. Same workspace-scoping join shape `getWorkspaceUsageRollup`
 * (`./usage.ts`) already uses: `LEFT JOIN tasks`/`LEFT JOIN pages` so both
 * task-scoped and page-scoped (Ask-thread) runs count, since a run is
 * task-scoped xor page-scoped in practice and only one join matches per row.
 *
 * Every field here is derived from a real column on `runs` — nothing is
 * fabricated. Fields this codebase genuinely cannot derive (see this file's
 * own "not included" note below, and `components/shell/ambient-status.tsx`'s
 * established precedent for "runtimes online") are simply absent from this
 * type, not filled in with a placeholder.
 */
export interface WorkspaceHealthMetrics {
  /** Runs currently claimed and executing (`dispatched`/`running`/`waiting_directory`). */
  activeRunsCount: number
  /** Runs waiting to be claimed (`status = 'queued'`). */
  queueDepth: number
  /**
   * Average milliseconds between `created_at` (enqueue) and `started_at`
   * (claimed + actually started) for runs that reached `started_at` within
   * the window — `null` if none did, rather than a misleading `0`.
   */
  claimLatencyMsAvg: number | null
  /**
   * completed / (completed + failed) among runs that reached a terminal
   * state within the window. `cancelled` runs are excluded from both the
   * numerator and denominator — a user-cancelled run isn't a system
   * success or failure, and folding it into either direction would distort
   * the rate. `null` if no run settled (completed or failed) in the window,
   * rather than a misleading `0` or `1`.
   */
  runSuccessRate: number | null
  /** Raw counts backing `runSuccessRate`, for a "N of M" display alongside the percentage. */
  completedCount: number
  failedCount: number
  windowDays: number
}

export async function getWorkspaceHealthMetrics(workspaceId: number, windowDays = 7): Promise<WorkspaceHealthMetrics> {
  const pool = getBrokerPool()

  const [activeRes, queuedRes, claimRes, outcomeRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN pages p ON p.id = r.page_id
       WHERE (t.workspace_id = $1 OR p.workspace_id = $1)
         AND r.status IN ('dispatched', 'running', 'waiting_directory')`,
      [workspaceId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN pages p ON p.id = r.page_id
       WHERE (t.workspace_id = $1 OR p.workspace_id = $1)
         AND r.status = 'queued'`,
      [workspaceId],
    ),
    pool.query<{ avg_ms: string | null; sample_count: string }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (r.started_at - r.created_at)) * 1000) AS avg_ms, COUNT(*) AS sample_count
       FROM runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN pages p ON p.id = r.page_id
       WHERE (t.workspace_id = $1 OR p.workspace_id = $1)
         AND r.started_at IS NOT NULL
         AND r.created_at >= now() - ($2::text || ' days')::interval`,
      [workspaceId, windowDays],
    ),
    pool.query<{ status: string; count: string }>(
      `SELECT r.status, COUNT(*) AS count
       FROM runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN pages p ON p.id = r.page_id
       WHERE (t.workspace_id = $1 OR p.workspace_id = $1)
         AND r.status IN ('completed', 'failed')
         AND r.completed_at >= now() - ($2::text || ' days')::interval
       GROUP BY r.status`,
      [workspaceId, windowDays],
    ),
  ])

  const completedCount = Number(outcomeRes.rows.find((row) => row.status === 'completed')?.count ?? 0)
  const failedCount = Number(outcomeRes.rows.find((row) => row.status === 'failed')?.count ?? 0)
  const settledCount = completedCount + failedCount

  return {
    activeRunsCount: Number(activeRes.rows[0]?.count ?? 0),
    queueDepth: Number(queuedRes.rows[0]?.count ?? 0),
    claimLatencyMsAvg:
      Number(claimRes.rows[0]?.sample_count ?? 0) > 0 && claimRes.rows[0]?.avg_ms != null
        ? Number(claimRes.rows[0].avg_ms)
        : null,
    runSuccessRate: settledCount > 0 ? completedCount / settledCount : null,
    completedCount,
    failedCount,
    windowDays,
  }
}
