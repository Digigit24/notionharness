import { getBrokerPool } from './db'
import { RUN_EVENTS_CHANNEL } from './notify'
import { bestEffort } from '@/lib/failures'
import type { RunEvent, RunMessageRow } from './types'

/** Appends one RunEvent to a run's transcript, assigning it a fresh monotonic
 * `seq` from `runs.next_seq` — the increment and the insert happen in one
 * transaction, so two concurrent appenders for the same run can never
 * receive the same seq or land out of order (docs/ROADMAP.html §3.1:
 * "Ordering comes from seq, never from timestamps or insertion order —
 * batched inserts return unordered and this is the bug that silently
 * scrambles transcripts"). */
export async function appendRunEvent(
  runId: number,
  event: RunEvent,
  /** Pre-assigned sequence number. Pass this whenever the caller already
   * knows the correct order — the dispatcher does, because
   * `acp-client.ts`'s `allocSeq()` numbers every envelope synchronously in
   * generation order before it leaves the process. Supplying it skips the
   * `UPDATE ... RETURNING next_seq` round-trip entirely, which is what let
   * concurrent appends race for their seq in the first place (whichever
   * write reached the remote database first won the lower number, so
   * word-chunks landed shuffled). Omit it and this falls back to allocating
   * from `runs.next_seq` as before, for callers with no ordering of their
   * own (page writes, one-off events). */
  explicitSeq?: number,
): Promise<{ seq: number; id: number }> {
  const pool = getBrokerPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let seq: number
    if (explicitSeq != null) {
      seq = explicitSeq
      // Keep `next_seq` ahead of any explicitly-written seq so a later
      // auto-allocating caller on the same run can't collide with one.
      await client.query(
        `UPDATE runs SET next_seq = GREATEST(next_seq, $2), updated_at = now() WHERE id = $1`,
        [runId, seq],
      )
    } else {
      const seqRes = await client.query<{ next_seq: string | number }>(
        `UPDATE runs SET next_seq = next_seq + 1, updated_at = now() WHERE id = $1 RETURNING next_seq`,
        [runId],
      )
      if (!seqRes.rows[0]) throw new Error(`Run ${runId} not found`)
      seq = Number(seqRes.rows[0].next_seq)
    }

    const insertRes = await client.query<{ id: string | number }>(
      `INSERT INTO run_messages (run_id, seq, event) VALUES ($1, $2, $3) RETURNING id`,
      [runId, seq, JSON.stringify(event)],
    )

    // Wakes any SSE route's subscribeToRunNotifications(runId, ...) the
    // instant this commits (Postgres queues NOTIFYs until COMMIT, so a
    // listener never sees this fire before the row is actually visible to
    // its own SELECT) — see notify.ts. Payload stays tiny (well under
    // NOTIFY's ~8000-byte limit): listeners re-fetch by seq, they don't
    // decode the event out of the notification itself.
    await client.query(`SELECT pg_notify($1, $2)`, [RUN_EVENTS_CHANNEL, JSON.stringify({ runId })])

    await client.query('COMMIT')
    return { seq, id: Number(insertRes.rows[0].id) }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Writes many events for one run in a single multi-row INSERT.
 *
 * The middle ground between the two ways this has been wrong: writing each
 * streamed chunk one-at-a-time in a chain made a reply take ~20s to become
 * durable (the database is remote, and Hermes emits a chunk per word),
 * while firing all of them concurrently made ~90 writes stampede a 3-
 * connection pool — they timed out against `connectionTimeoutMillis` AND
 * starved every other request in the process, which surfaced to the user as
 * a 500 on the next thing they clicked. One batch is one connection and one
 * round-trip regardless of how many chunks it carries.
 *
 * Every row carries a caller-assigned `seq` (see `appendRunEvent`), so a
 * batch can't reorder anything. Conflicts are ignored rather than thrown:
 * a retry re-sending an already-written seq is a no-op, not an error.
 */
export async function appendRunEventsBatch(
  runId: number,
  entries: Array<{ seq: number; event: RunEvent }>,
): Promise<void> {
  if (entries.length === 0) return
  const pool = getBrokerPool()

  const values: unknown[] = [runId]
  const tuples = entries.map((entry, i) => {
    values.push(entry.seq, JSON.stringify(entry.event))
    return `($1, $${i * 2 + 2}, $${i * 2 + 3})`
  })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO run_messages (run_id, seq, event) VALUES ${tuples.join(', ')}
       ON CONFLICT (run_id, seq) DO NOTHING`,
      values,
    )
    const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), 0)
    await client.query(`UPDATE runs SET next_seq = GREATEST(next_seq, $2), updated_at = now() WHERE id = $1`, [
      runId,
      maxSeq,
    ])
    await client.query(`SELECT pg_notify($1, $2)`, [RUN_EVENTS_CHANNEL, JSON.stringify({ runId })])
    await client.query('COMMIT')
  } catch (err) {
    await bestEffort(
      client.query('ROLLBACK'),
      'the original error is what the caller needs; a rollback that also fails must not replace it',
    )
    throw err
  } finally {
    client.release()
  }
}

/** Highest seq already written for a run — the dispatcher reads this ONCE
 * before a turn starts, then offsets every envelope's own in-process seq
 * above it (`acp-client.ts` restarts its counter at 1 per turn, and
 * `enqueueAskRun` has usually already written the user's own message at
 * seq 1). One query per turn instead of one per streamed chunk. */
export async function getRunSeqBase(runId: number): Promise<number> {
  const pool = getBrokerPool()
  const res = await pool.query<{ max_seq: string | number | null }>(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_messages WHERE run_id = $1`,
    [runId],
  )
  return Number(res.rows[0]?.max_seq ?? 0)
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

/**
 * Reads every event for a whole SET of runs in one round trip, grouped by
 * run id — what a multi-run view (e.g. the "Ask" page's combined
 * conversation, adaptRunSnapshotsToThread) needs instead of one
 * `listRunEvents` call per run. Confirmed live as a real bug, not a
 * hypothetical: an agent with 18 standalone runs meant `getAskRunSnapshots`
 * firing 18 concurrent queries via `Promise.all` — against a broker pool
 * capped at 3 connections (lib/broker/db.ts) — which both stalled the page
 * (queries queueing 3-at-a-time behind each other, some hitting the 8s
 * `connectionTimeoutMillis` outright) and added contention that produced
 * real "timeout exceeded when trying to connect" errors elsewhere (the SSE
 * route, the dispatcher tick) at the same time. One query beats N regardless
 * of pool size — this isn't just a pressure fix, it's faster outright. */
export async function listRunEventsForRuns(runIds: number[]): Promise<Map<number, RunMessageRow[]>> {
  const byRun = new Map<number, RunMessageRow[]>()
  if (runIds.length === 0) return byRun
  const pool = getBrokerPool()
  const res = await pool.query<{ run_id: string | number; seq: string | number; event: RunEvent; created_at: Date }>(
    `SELECT run_id, seq, event, created_at FROM run_messages WHERE run_id = ANY($1) ORDER BY run_id ASC, seq ASC`,
    [runIds],
  )
  for (const r of res.rows) {
    const runId = Number(r.run_id)
    const row: RunMessageRow = { seq: Number(r.seq), event: r.event, createdAt: r.created_at.toISOString() }
    const existing = byRun.get(runId)
    if (existing) existing.push(row)
    else byRun.set(runId, [row])
  }
  return byRun
}

/** ROADMAP 6.3 — the run-card block's "N steps" chip needs a count, not the
 * full transcript `listRunEvents` returns (which would mean fetching every
 * tool_call/tool_result payload just to count them). */
export async function countRunEvents(runId: number): Promise<number> {
  const pool = getBrokerPool()
  const res = await pool.query<{ count: string }>(`SELECT count(*) FROM run_messages WHERE run_id = $1`, [runId])
  return Number(res.rows[0]?.count ?? 0)
}
