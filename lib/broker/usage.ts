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
