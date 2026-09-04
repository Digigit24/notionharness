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

/** A workspace rollup, plus how many distinct runs produced it. Cost alone
 * answers "how much" but never "how much per run", which is the question
 * anyone reading a spend figure asks next. */
export interface WorkspaceUsageRollup extends RunUsageTotals {
  runCount: number
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

/** ROADMAP B7.2 (Batch B-6 "Finish") — cost audit's real gap: the agents list
 * page had no per-agent spend anywhere, and `runs.agent_id` already exists
 * directly on the row (see lib/broker/runs.ts's `RunRow`/`getActiveRunForAgent`),
 * so this needs no join through tasks/pages at all — simplest of the five
 * rollups in this file. Same trailing-window/summed-on-read shape as
 * `getProjectUsageRollup`. */
export async function getAgentUsageRollup(agentId: number, sinceDays = 7): Promise<RunUsageTotals> {
  const pool = getBrokerPool()
  const res = await pool.query<{ total_tokens: string | null; total_cost_ticks: string | null }>(
    `SELECT COALESCE(SUM(ru.tokens), 0) AS total_tokens, COALESCE(SUM(ru.cost_ticks), 0) AS total_cost_ticks
     FROM run_usage ru
     INNER JOIN runs r ON r.id = ru.run_id
     WHERE r.agent_id = $1
       AND ru.created_at >= now() - ($2::text || ' days')::interval`,
    [agentId, sinceDays],
  )
  const row = res.rows[0]
  return {
    totalTokens: Number(row?.total_tokens ?? 0),
    totalCostTicks: Number(row?.total_cost_ticks ?? 0),
  }
}

/** ROADMAP B7.2 — batched version of `getAgentUsageRollup` for an agent list
 * page, same shape as `getRunUsageTotalsForRuns`: one query for every agent
 * id at once rather than N. Agents with no usage rows in the window are
 * simply absent from the returned map (callers should default to zero). */
export async function getAgentUsageRollupForAgents(
  agentIds: number[],
  sinceDays = 7,
): Promise<Record<number, RunUsageTotals>> {
  if (agentIds.length === 0) return {}
  const pool = getBrokerPool()
  const res = await pool.query<{ agent_id: string; total_tokens: string | null; total_cost_ticks: string | null }>(
    `SELECT r.agent_id, COALESCE(SUM(ru.tokens), 0) AS total_tokens, COALESCE(SUM(ru.cost_ticks), 0) AS total_cost_ticks
     FROM run_usage ru
     INNER JOIN runs r ON r.id = ru.run_id
     WHERE r.agent_id = ANY($1::bigint[])
       AND ru.created_at >= now() - ($2::text || ' days')::interval
     GROUP BY r.agent_id`,
    [agentIds, sinceDays],
  )
  const map: Record<number, RunUsageTotals> = {}
  for (const row of res.rows) {
    map[Number(row.agent_id)] = {
      totalTokens: Number(row.total_tokens ?? 0),
      totalCostTicks: Number(row.total_cost_ticks ?? 0),
    }
  }
  return map
}

/** ROADMAP B5.1/B1.5 (home surface "what it is costing" + the ambient status
 * bar's spend stat) — same join-through-`tasks` pattern as
 * `getProjectUsageRollup`, one level up (workspace instead of project), plus
 * a second `LEFT JOIN` to `pages` so page-scoped runs (Ask threads, which
 * carry `page_id` but no `task_id` — see `listRecentPageRunsForWorkspace`)
 * are counted too; a rollup that only walked `tasks` would silently miss
 * every dollar an Ask thread spent. A run is task-scoped xor page-scoped in
 * practice, so exactly one of the two joins matches per row. */
export async function getWorkspaceUsageRollup(
  workspaceId: number,
  sinceDays = 7,
): Promise<WorkspaceUsageRollup> {
  const pool = getBrokerPool()
  const res = await pool.query<{
    total_tokens: string | null
    total_cost_ticks: string | null
    run_count: string | null
  }>(
    // COUNT(DISTINCT) rather than COUNT: `run_usage` holds several rows per
    // run, so a plain count would report usage events, not runs.
    `SELECT COALESCE(SUM(ru.tokens), 0) AS total_tokens,
            COALESCE(SUM(ru.cost_ticks), 0) AS total_cost_ticks,
            COUNT(DISTINCT ru.run_id) AS run_count
     FROM run_usage ru
     INNER JOIN runs r ON r.id = ru.run_id
     LEFT JOIN tasks t ON t.id = r.task_id
     LEFT JOIN pages p ON p.id = r.page_id
     -- Standalone "Ask" runs have neither a task nor a page, so they reach a
     -- workspace only through their agent. Without this join their tokens and
     -- cost were silently dropped from every workspace rollup — the shell's
     -- spend readout stayed at $0.00 no matter how much an Ask thread spent.
     LEFT JOIN agents a ON a.id = r.agent_id
     WHERE (t.workspace_id = $1 OR p.workspace_id = $1 OR a.workspace_id = $1)
       AND ru.created_at >= now() - ($2::text || ' days')::interval`,
    [workspaceId, sinceDays],
  )
  const row = res.rows[0]
  return {
    totalTokens: Number(row?.total_tokens ?? 0),
    totalCostTicks: Number(row?.total_cost_ticks ?? 0),
    runCount: Number(row?.run_count ?? 0),
  }
}
