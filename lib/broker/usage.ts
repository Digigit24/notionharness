import { getBrokerPool } from './db'

export interface UsageInput {
  provider?: string
  model?: string
  tokens?: number
  costTicks?: number
}

/** Records one usage event against a run — raw per-event rows; hourly/daily
 * rollups (docs/ROADMAP.html §8.4) are a later pillar, not built here. */
export async function recordUsage(runId: number, usage: UsageInput): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `INSERT INTO run_usage (run_id, provider, model, tokens, cost_ticks) VALUES ($1, $2, $3, $4, $5)`,
    [runId, usage.provider ?? null, usage.model ?? null, usage.tokens ?? null, usage.costTicks ?? null],
  )
}

export interface RunUsageTotals {
  totalTokens: number
  totalCostTicks: number
}

/** ROADMAP 6.3 — the run-card block's cost chip needs a total, not the raw
 * per-event rows `recordUsage` writes; summed on read rather than kept as a
 * running total on `runs` itself, matching this file's own "rollups are a
 * later pillar" scope note — a run has few enough usage rows for a plain
 * SUM to be cheap at this scale. */
export async function getRunUsageTotals(runId: number): Promise<RunUsageTotals> {
  const pool = getBrokerPool()
  const res = await pool.query<{ total_tokens: string | null; total_cost_ticks: string | null }>(
    `SELECT COALESCE(SUM(tokens), 0) AS total_tokens, COALESCE(SUM(cost_ticks), 0) AS total_cost_ticks FROM run_usage WHERE run_id = $1`,
    [runId],
  )
  const row = res.rows[0]
  return {
    totalTokens: Number(row?.total_tokens ?? 0),
    totalCostTicks: Number(row?.total_cost_ticks ?? 0),
  }
}

export interface TaskUsageTotals {
  totalTokens: number
  totalCostTicks: number
  runCount: number
}

/** ROADMAP B-1 — the task detail page's right-rail "execution aggregate":
 * lifetime tokens/cost/run count across every run ever queued against a
 * task, not just the latest. No per-task rollup table exists — same
 * "summed on read" reasoning as `getRunUsageTotals` above, one level up: a
 * task has few enough runs for a live join to stay cheap. */
export async function getTaskUsageTotals(taskId: number): Promise<TaskUsageTotals> {
  const pool = getBrokerPool()
  const res = await pool.query<{ total_tokens: string | null; total_cost_ticks: string | null; run_count: string | null }>(
    `SELECT COALESCE(SUM(ru.tokens), 0) AS total_tokens,
            COALESCE(SUM(ru.cost_ticks), 0) AS total_cost_ticks,
            (SELECT COUNT(*) FROM runs WHERE task_id = $1) AS run_count
     FROM run_usage ru
     JOIN runs r ON r.id = ru.run_id
     WHERE r.task_id = $1`,
    [taskId],
  )
  const row = res.rows[0]
  return {
    totalTokens: Number(row?.total_tokens ?? 0),
    totalCostTicks: Number(row?.total_cost_ticks ?? 0),
    runCount: Number(row?.run_count ?? 0),
  }
}
