import { randomBytes } from 'node:crypto'
import { getBrokerPool } from './db'
import type { Run, RunStatus, SuggestionStatus } from './types'

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
  page_id: string | number | null
  page_subtree_block_id: string | null
  suggestion_status: SuggestionStatus
  prompt: string | null
  next_seq: string | number
  // node-postgres's default type parser returns `timestamp`/`timestamptz`
  // columns as `Date` objects, not strings — this pool has no custom OID
  // parser configured (lib/broker/db.ts), so these five fields are `Date`
  // at runtime despite Postgres storing them as timestamps. `Run`'s own
  // type contract promises `string` (ISO), so `rowToRun` below must
  // convert explicitly — every consumer (e.g. Array.sort's .localeCompare)
  // trusted that contract and broke at runtime when it silently wasn't met.
  lease_expires_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  dismissed_at: Date | null
  error: string | null
  mcp_overlay: unknown
  run_token: string | null
  created_at: Date
  updated_at: Date
}

function toISOStringOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
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
    pageId: row.page_id === null ? null : Number(row.page_id),
    pageSubtreeBlockId: row.page_subtree_block_id,
    suggestionStatus: row.suggestion_status,
    prompt: row.prompt,
    nextSeq: Number(row.next_seq),
    leaseExpiresAt: toISOStringOrNull(row.lease_expires_at),
    startedAt: toISOStringOrNull(row.started_at),
    completedAt: toISOStringOrNull(row.completed_at),
    dismissedAt: toISOStringOrNull(row.dismissed_at),
    error: row.error,
    mcpOverlay: row.mcp_overlay,
    runToken: row.run_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/** ENQUEUE (docs/ROADMAP.html §4.3) — inserts a queued run. The partial unique
 * index on (task_id, agent_id, page_id) for non-terminal runs (see
 * `lib/broker/migrations/0004_runs_task_agent_active_uidx_null_safe.sql`)
 * refuses a second concurrent run for the same (task, agent) pair, or the
 * same (agent, page) pair for page-scoped runs where task_id is NULL. */
export async function enqueueRun(input: {
  taskId?: number | null
  agentId?: number | null
  originatorUser?: number | null
  accountableUser: number
  priority?: number
  maxAttempts?: number
  /** Prompt delivered to the agent for a page-scoped run. */
  prompt?: string | null
  /** Page owning a page-scoped run; independent of task_id. */
  pageId?: number | null
}): Promise<Run> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `INSERT INTO runs (task_id, agent_id, status, originator_user, accountable_user, priority, max_attempts, prompt, page_id)
     VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.taskId ?? null,
      input.agentId ?? null,
      input.originatorUser ?? null,
      input.accountableUser,
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.prompt ?? null,
      input.pageId ?? null,
    ],
  )
  return rowToRun(res.rows[0])
}

/** CLAIM (docs/ROADMAP.html §4.3) — one UPDATE with a `FOR UPDATE SKIP LOCKED`
 * subquery selecting the row to claim, never select-then-update ("Two hosts
 * will both win" otherwise). Returns null if nothing is queued.
 *
 * Per 4.7, "minted at claim, dead at settle": `run_token` — the bearer
 * credential `POST /api/daemon/page-writes` checks — is generated here, in
 * the same atomic UPDATE as status/worker_id/lease, not as a separate step
 * that could race with another claim or leave a claimed-but-not-yet-tokened
 * window. `settleRun` already wipes it back to NULL on every terminal
 * transition (see below); minting it anywhere but claim would either miss
 * that "dead at settle" guarantee or need its own extra round trip. */
export async function claimNextRun(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<Run | null> {
  const pool = getBrokerPool()
  const runToken = randomBytes(32).toString('hex')
  const res = await pool.query<RunRow>(
    `UPDATE runs
     SET status = 'dispatched',
         worker_id = $1,
         lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
         run_token = $3,
         updated_at = now()
     WHERE id = (
       SELECT id FROM runs
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, leaseMs, runToken],
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
        `INSERT INTO runs (task_id, agent_id, status, attempt, max_attempts, retry_of, priority, originator_user, accountable_user, prompt, page_id)
         VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [run.taskId, run.agentId, run.attempt + 1, run.maxAttempts, run.id, run.priority, run.originatorUser, run.accountableUser, run.prompt, run.pageId],
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
       AND r.status IN ('queued', 'dispatched', 'running', 'waiting_directory')
     ORDER BY r.created_at DESC`,
    [workspaceId],
  )
  return res.rows.map(rowToRun)
}

/** ROADMAP B-1 (project detail, Runs tab) — every run across a project's
 * tasks, newest first, optionally narrowed to one agent. Same "join through
 * the Payload-owned `tasks` table" pattern `listActiveRunsForWorkspace`
 * already established (runs carry no project/workspace column of their
 * own — D5). `limit` is optional; omitted, the caller gets every run (the
 * Runs tab wants the full list for its cost rollup, not a page of it). */
export async function listRunsForProject(projectId: number, opts: { agentId?: number | null; limit?: number } = {}): Promise<Run[]> {
  const pool = getBrokerPool()
  const conditions = ['t.project_id = $1']
  const params: unknown[] = [projectId]
  if (opts.agentId != null) {
    params.push(opts.agentId)
    conditions.push(`r.agent_id = $${params.length}`)
  }
  let limitClause = ''
  if (opts.limit) {
    params.push(opts.limit)
    limitClause = `LIMIT $${params.length}`
  }
  const res = await pool.query<RunRow>(
    `SELECT r.* FROM runs r
     INNER JOIN tasks t ON t.id = r.task_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.created_at DESC
     ${limitClause}`,
    params,
  )
  return res.rows.map(rowToRun)
}

/** Same non-terminal status set as `listActiveRunsForWorkspace`, scoped to
 * one project's tasks instead of a whole workspace — backs the Overview
 * tab's "active runs" count. */
export async function listActiveRunsForProject(projectId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT r.* FROM runs r
     INNER JOIN tasks t ON t.id = r.task_id
     WHERE t.project_id = $1
       AND r.status IN ('queued', 'dispatched', 'running', 'waiting_directory')
     ORDER BY r.created_at DESC`,
    [projectId],
  )
  return res.rows.map(rowToRun)
}

/** ROADMAP 6.3 audit — the @mention live-status dot's data source: is this
 * agent doing something right now, regardless of which task/page it's on.
 * Same non-terminal status set `listActiveRunsForWorkspace` and the run-card
 * block use. */
export async function getActiveRunForAgent(agentId: number): Promise<Run | null> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT * FROM runs
     WHERE agent_id = $1
       AND status IN ('queued', 'dispatched', 'running', 'waiting_directory')
     ORDER BY created_at DESC
     LIMIT 1`,
    [agentId],
  )
  return res.rows[0] ? rowToRun(res.rows[0]) : null
}

/** ROADMAP B-4 "Work" (agent columns' "Live" pulse) — task-scoped counterpart
 * to `getActiveRunForAgent`: is *this task* (regardless of which agent)
 * mid-run right now. Same non-terminal status set every other "is something
 * active" read in this file uses. `listActiveRunsForWorkspace` already
 * covers a whole board's worth of tasks in one query and is what the task
 * board itself uses for its presence dot — this single-task variant exists
 * for a consumer (a task detail page, a list/table row rendered outside a
 * board fetch) that only has one task id in hand and shouldn't have to pull
 * every active run in the workspace just to answer one boolean. */
export async function hasActiveRunForTask(taskId: number): Promise<boolean> {
  const pool = getBrokerPool()
  const res = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM runs
       WHERE task_id = $1
         AND status IN ('queued', 'dispatched', 'running', 'waiting_directory')
     ) AS exists`,
    [taskId],
  )
  return res.rows[0]?.exists ?? false
}

export async function getRunPageContext(runId: number): Promise<{ pageId: number; subtreeBlockId: string } | null> {
  const pool = getBrokerPool()
  const res = await pool.query<{ page_id: string | number | null; page_subtree_block_id: string | null }>(
    `SELECT page_id, page_subtree_block_id FROM runs WHERE id = $1`,
    [runId],
  )
  const row = res.rows[0]
  if (!row || row.page_id === null || row.page_subtree_block_id === null) return null
  return { pageId: Number(row.page_id), subtreeBlockId: row.page_subtree_block_id }
}

export async function setRunPageContext(runId: number, pageId: number, subtreeBlockId: string): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE runs SET page_id = $2, page_subtree_block_id = $3, updated_at = now() WHERE id = $1`,
    [runId, pageId, subtreeBlockId],
  )
}

/** ROADMAP B-2 (Moat/provenance) — every run that has ever written to a
 * page, newest first. `page_id` is the right join key regardless of how the
 * run started: a page-scoped "ask agent" run (`enqueuePageRun`) sets it at
 * enqueue time, and a task-scoped run sets it lazily on its *first* block
 * write via `setRunPageContext` (see `app/api/daemon/page-writes/route.ts`)
 * — so this single column already unifies both origins, no extra join
 * needed. A run that was claimed/started but never actually wrote a block
 * (e.g. it's still queued, or it failed before its first write) has
 * `page_id IS NULL` and is correctly excluded — `lib/provenance.ts` only
 * cares about runs that actually produced committed `page_write` events. */
export async function listRunsForPage(pageId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(`SELECT * FROM runs WHERE page_id = $1 ORDER BY created_at DESC`, [pageId])
  return res.rows.map(rowToRun)
}

/** ROADMAP B3.1 (Batch B-2, suggestions mode) — every run with a still-
 * pending page subtree on a page, oldest first (review order). Deliberately
 * not filtered by the run's own dispatcher `status`: a human can accept or
 * reject a still-running run's suggestions at any time — `appendBlockToSubtree`
 * (lib/agent-page-writes.ts) already treats a deleted subtree as "the human
 * doesn't want this run's output anymore, stop appending," so rejecting
 * mid-run is a safe, already-anticipated case, not a new one this introduces. */
export async function listPendingSuggestionRunsForPage(pageId: number): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT * FROM runs
     WHERE page_id = $1
       AND page_subtree_block_id IS NOT NULL
       AND suggestion_status = 'pending'
     ORDER BY created_at ASC`,
    [pageId],
  )
  return res.rows.map(rowToRun)
}

/** Transitions a run's page-subtree suggestion state. `lib/agent-suggestions.ts`
 * is the only caller — this is a plain state write, not a Yjs mutation. */
export async function setSuggestionStatus(runId: number, status: SuggestionStatus): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(`UPDATE runs SET suggestion_status = $2, updated_at = now() WHERE id = $1`, [runId, status])
}

// ---------------------------------------------------------------------------
// P5.5 inbox reads — read-only queries backing the Inbox home screen's
// categorized sections. Deliberately user-scoped (accountable or originator),
// not workspace-scoped: the runs/run_messages tables have no workspace column
// (runs are D5 raw-pg tables, and a task->run join can't scope them either
// since task_id is unpopulated today). Matches the notifications bell, which
// is also cross-workspace by design. The outstanding-approval read lives in
// the P5.4 `approvals` collection (lib/hermes/approval-helpers.ts), not here.
// ---------------------------------------------------------------------------

/** Failed runs attributed to the user, newest first. Excludes runs the user
 * already dismissed from the Inbox (ROADMAP B5.2) — a dismissed failed run
 * is still failed, it just no longer needs to sit in the inbox. */
export async function listFailedRuns(userId: number, limit = 10): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT * FROM runs
     WHERE status = 'failed'
       AND dismissed_at IS NULL
       AND (accountable_user = $1 OR originator_user = $1)
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, limit],
  )
  return res.rows.map(rowToRun)
}

/** Runs that finished with at least one `file_change` event — "a diff ready
 * to review" surfaced from the transcript, pre-Pillar-6 dedicated review
 * surface. Excludes runs the user already dismissed from the Inbox
 * (ROADMAP B5.2), same reasoning as `listFailedRuns`. */
export async function listReviewReadyRuns(userId: number, limit = 10): Promise<Run[]> {
  const pool = getBrokerPool()
  const res = await pool.query<RunRow>(
    `SELECT DISTINCT r.*
     FROM runs r
     JOIN run_messages rm ON rm.run_id = r.id
     WHERE r.status = 'completed'
       AND r.dismissed_at IS NULL
       AND rm.event->>'type' = 'file_change'
       AND (r.accountable_user = $1 OR r.originator_user = $1)
     ORDER BY r.updated_at DESC
     LIMIT $2`,
    [userId, limit],
  )
  return res.rows.map(rowToRun)
}

/** ROADMAP B5.2 (Batch B-5 "Attention") — clears a run out of the Inbox's
 * failed/review-ready sections. Deliberately does not touch `status`/`error`
 * — dismissing is an inbox-visibility concept, not an outcome correction.
 * Idempotent (a second dismiss of an already-dismissed run is a no-op, not
 * an error) so a double-click or a retried request can never fail loudly. */
export async function dismissRun(runId: number): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `UPDATE runs SET dismissed_at = now(), updated_at = now() WHERE id = $1 AND dismissed_at IS NULL`,
    [runId],
  )
}
