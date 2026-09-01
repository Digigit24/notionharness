import { getBrokerPool } from './db'
import type { Run, RunStatus } from './types'

const DEFAULT_LEASE_MS = 60_000

interface RunRow {
  id: string | number
  task_id: string | number | null
  agent_id: string | number | null
  status: RunStatus
  attempt: number
  max_attempts: number
  retry_of: string | number | null
  priority: number
  originator_user: number | null
  accountable_user: number
  worker_id: string | null
  external_session_id: string | null
  next_seq: string | number
  lease_expires_at: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
  mcp_overlay: unknown
  run_token: string | null
  created_at: string
  updated_at: string
}

function rowToRun(row: RunRow): Run {
  return {
    id: Number(row.id),
    taskId: row.task_id === null ? null : Number(row.task_id),
    agentId: row.agent_id === null ? null : Number(row.agent_id),
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    retryOf: row.retry_of === null ? null : Number(row.retry_of),
    priority: row.priority,
    originatorUser: row.originator_user,
    accountableUser: row.accountable_user,
    workerId: row.worker_id,
    externalSessionId: row.external_session_id,
    nextSeq: Number(row.next_seq),
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    mcpOverlay: row.mcp_overlay,
    runToken: row.run_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** ENQUEUE (docs/ROADMAP.html §4.3) — inserts a queued run. The partial unique
 * index on (task_id, agent_id) for non-terminal runs (see the migration SQL)
 * refuses a second concurrent run for the same pair. */
export async function enqueueRun(input: {
  taskId?: number | null
  agentId?: number | null
  originatorUser?: number | null
  accountableUser: number
  priority?: number
  maxAttempts?: number
}): Promise<Run> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `INSERT INTO runs (task_id, agent_id, status, originator_user, accountable_user, priority, max_attempts)
     VALUES ($1, $2, 'queued', $3, $4, $5, $6)
     RETURNING *`,
    [
      input.taskId ?? null,
      input.agentId ?? null,
      input.originatorUser ?? null,
      input.accountableUser,
      input.priority ?? 0,
      input.maxAttempts ?? 3,
    ],
  )
  return rowToRun(res.rows[0])
}

/** CLAIM (docs/ROADMAP.html §4.3) — one UPDATE with a `FOR UPDATE SKIP LOCKED`
 * subquery selecting the row to claim, never select-then-update ("Two hosts
 * will both win" otherwise). Returns null if nothing is queued. */
export async function claimNextRun(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<Run | null> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `UPDATE runs
     SET status = 'dispatched',
         worker_id = $1,
         lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
         updated_at = now()
     WHERE id = (
       SELECT id FROM runs
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, leaseMs],
  )
  return res.rows[0] ? rowToRun(res.rows[0]) : null
}

/** Transitions a claimed run into 'running' once execution actually starts —
 * distinguishing "claimed but never started" (what RECOVER targets) from
 * "started, then the worker died" (also swept, see sweepExpiredLeases). */
export async function markRunStarted(runId: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE runs SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1 AND status = 'dispatched'`,
    [runId],
  )
}

/** Heartbeat — extends a claimed run's lease so a long-running task isn't
 * reclaimed by the sweeper out from under its own worker. */
export async function renewLease(runId: number, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE runs SET lease_expires_at = now() + ($2::text || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
    [runId, leaseMs],
  )
}

export type SettleOutcome = 'completed' | 'failed' | 'cancelled'

/** SETTLE (docs/ROADMAP.html §4.3) — terminal transition. Wipes `mcp_overlay`/
 * `run_token` per §4.7 (no live bearer token may linger in a settled row). On
 * a retryable failure under `max_attempts`, enqueues a fresh run with
 * `retry_of` set and attribution inherited, all in the same transaction as
 * the settle so a settled run and its retry are never observed out of sync. */
export async function settleRun(
  runId: number,
  outcome: SettleOutcome,
  opts: { error?: string; retryable?: boolean } = {},
): Promise<{ settled: Run; retry: Run | null }> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const current = await client.query<RunRow>(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [runId])
    if (!current.rows[0]) throw new Error(`Run ${runId} not found`)
    const run = rowToRun(current.rows[0])

    const settledRes = await client.query<RunRow>(
      `UPDATE runs
       SET status = $2, completed_at = now(), error = $3, mcp_overlay = NULL, run_token = NULL, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [runId, outcome, opts.error ?? null],
    )

    let retry: Run | null = null
    if (outcome === 'failed' && opts.retryable && run.attempt < run.maxAttempts) {
      const created = await client.query<RunRow>(
        `INSERT INTO runs (task_id, agent_id, status, attempt, max_attempts, retry_of, priority, originator_user, accountable_user)
         VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [run.taskId, run.agentId, run.attempt + 1, run.maxAttempts, run.id, run.priority, run.originatorUser, run.accountableUser],
      )
      retry = rowToRun(created.rows[0])
    }

    await client.query('COMMIT')
    return { settled: rowToRun(settledRes.rows[0]), retry }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** RECOVER (docs/ROADMAP.html §4.3) — reclaims runs whose lease lapsed before
 * their outcome got home. The roadmap's own wording covers 'dispatched' with
 * `started_at IS NULL` ("the claim committed but the response never got
 * home"); this also reclaims 'running' rows with an expired lease, on the
 * same reasoning applied one step later — a lease that isn't renewed (see
 * `renewLease`) means whatever worker held it is no longer around, whether
 * it died before or after actually starting. Re-queues affected rows
 * (status back to 'queued', lease/worker cleared) for a fresh claim. */
export async function sweepExpiredLeases(): Promise<number> {
  const pool = getBrokerPool()
  const res = await pool.query(
    `UPDATE runs
     SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE status IN ('dispatched', 'running')
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()`,
  )
  return res.rowCount ?? 0
}

export async function getRun(runId: number): Promise<Run | null> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId])
  return res.rows[0] ? rowToRun(res.rows[0]) : null
}

export async function listRunsForTask(taskId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(`SELECT * FROM runs WHERE task_id = $1 ORDER BY created_at DESC`, [taskId])
  return res.rows.map(rowToRun)
}

/** Returns non-terminal runs for tasks in a workspace, used by board-level
 * presence indicators. Runs intentionally have no workspace column; ownership
 * is resolved through the Payload-owned tasks table. */
export async function listActiveRunsForWorkspace(workspaceId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT r.* FROM runs r
     INNER JOIN tasks t ON t.id = r.task_id
     WHERE t.workspace_id = $1
       AND r.status IN ('queued', 'dispatched', 'running')
     ORDER BY r.created_at DESC`,
    [workspaceId],
  )
  return res.rows.map(rowToRun)
}
