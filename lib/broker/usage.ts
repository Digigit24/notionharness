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

/** ROADMAP B-1 (project detail, Runs tab) — batched version of
 * `getRunUsageTotals` for a list of runs at once, so a run list doesn't do
 * one query per row. Runs with no usage rows at all are simply absent from
 * the returned map (callers should default to zero). */
export async function getRunUsageTotalsForRuns(runIds: number[]): Promise<Record<number, RunUsageTotals>> {
  if (runIds.length === 0) return {}
  const pool = getBrokerPool()
  const res = await pool.query<{ run_id: string; total_tokens: string | null; total_cost_ticks: string | null }>(
    `SELECT run_id, COALESCE(SUM(tokens), 0) AS total_tokens, COALESCE(SUM(cost_ticks), 0) AS total_cost_ticks
     FROM run_usage
     WHERE run_id = ANY($1::bigint[])
     GROUP BY run_id`,
    [runIds],
  )
  const map: Record<number, RunUsageTotals> = {}
  for (const row of res.rows) {
    map[Number(row.run_id)] = {
      totalTokens: Number(row.total_tokens ?? 0),
      totalCostTicks: Number(row.total_cost_ticks ?? 0),
    }
  }
  return map
}

/** ROADMAP B-1 (project detail, Overview tab) — "30-day spend" from the
 * plan text: cost_ticks summed from `run_usage` for every run belonging to
 * this project's tasks, in the trailing window. Same join-through-`tasks`
 * pattern as `listRunsForProject`. */
export async function getProjectUsageRollup(projectId: number, sinceDays = 30): Promise<RunUsageTotals> {
  const pool = getBrokerPool()
  const res = await pool.query<{ total_tokens: string | null; total_cost_ticks: string | null }>(
    `SELECT COALESCE(SUM(ru.tokens), 0) AS total_tokens, COALESCE(SUM(ru.cost_ticks), 0) AS total_cost_ticks
     FROM run_usage ru
     INNER JOIN runs r ON r.id = ru.run_id
     INNER JOIN tasks t ON t.id = r.task_id
     WHERE t.project_id = $1
       AND ru.created_at >= now() - ($2::text || ' days')::interval`,
    [projectId, sinceDays],
  )
  const row = res.rows[0]
  return {
    totalTokens: Number(row?.total_tokens ?? 0),
    totalCostTicks: Number(row?.total_cost_ticks ?? 0),
  }
}
