import { getBrokerPool } from './db'
import type { RunEvent, RunMessageRow } from './types'

/** Appends one RunEvent to a run's transcript, assigning it a fresh monotonic
 * `seq` from `runs.next_seq` — the increment and the insert happen in one
 * transaction, so two concurrent appenders for the same run can never
 * receive the same seq or land out of order (docs/ROADMAP.html §3.1:
 * "Ordering comes from seq, never from timestamps or insertion order —
 * batched inserts return unordered and this is the bug that silently
 * scrambles transcripts"). */
export async function appendRunEvent(runId: number, event: RunEvent): Promise<{ seq: number; id: number }> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const seqRes = await client.query<{ next_seq: string | number }>(
      `UPDATE runs SET next_seq = next_seq + 1, updated_at = now() WHERE id = $1 RETURNING next_seq`,
      [runId],
    )
    if (!seqRes.rows[0]) throw new Error(`Run ${runId} not found`)
    const seq = Number(seqRes.rows[0].next_seq)

    const insertRes = await client.query<{ id: string | number }>(
      `INSERT INTO run_messages (run_id, seq, event) VALUES ($1, $2, $3) RETURNING id`,
      [runId, seq, JSON.stringify(event)],
    )

    await client.query('COMMIT')
    return { seq, id: Number(insertRes.rows[0].id) }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Reads a run's transcript in `seq` order — the only ordering that's ever correct. */
export async function listRunEvents(runId: number): Promise<RunMessageRow[]> {
  const pool = getBrokerPool()
  // node-postgres's default type parser returns `timestamptz` as a `Date`
  // object (no custom OID parser configured on this pool — see db.ts) —
  // `RunMessageRow.createdAt` promises `string` (ISO), so convert here
  // rather than leaking a Date to every consumer of this row shape.
  const res = await pool.query<{ seq: string | number; event: RunEvent; created_at: Date }>(
    `SELECT seq, event, created_at FROM run_messages WHERE run_id = $1 ORDER BY seq ASC`,
    [runId],
  )
  return res.rows.map((r) => ({ seq: Number(r.seq), event: r.event, createdAt: r.created_at.toISOString() }))
}

/** Reads only the tail of a run's transcript after `sinceSeq`, still in
 * `seq` order — what the P5.7 SSE stream route (`app/api/runs/[runId]/
 * events/stream/route.ts`) uses both for a reconnecting client's catch-up
 * flush and for each poll tick, so a client never re-receives (or, worse,
 * misses) events across a reconnect. */
export async function listRunEventsSince(runId: number, sinceSeq: number): Promise<RunMessageRow[]> {
  const pool = getBrokerPool()
  const res = await pool.query<{ seq: string | number; event: RunEvent; created_at: Date }>(
    `SELECT seq, event, created_at FROM run_messages WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC`,
    [runId, sinceSeq],
  )
  return res.rows.map((r) => ({ seq: Number(r.seq), event: r.event, createdAt: r.created_at.toISOString() }))
}

/** ROADMAP 6.3 — the run-card block's "N steps" chip needs a count, not the
 * full transcript `listRunEvents` returns (which would mean fetching every
 * tool_call/tool_result payload just to count them). */
export async function countRunEvents(runId: number): Promise<number> {
  const pool = getBrokerPool()
  const res = await pool.query<{ count: string }>(`SELECT count(*) FROM run_messages WHERE run_id = $1`, [runId])
  return Number(res.rows[0]?.count ?? 0)
}
