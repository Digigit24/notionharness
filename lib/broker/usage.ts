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
