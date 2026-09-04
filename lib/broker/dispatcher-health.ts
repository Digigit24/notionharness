// R3.3 — is the dispatcher actually running?
//
// The dispatcher is one manually started process (`scripts/run-dispatcher-
// loop.ts` polling `/api/dispatcher/tick`). When it stops — a closed
// terminal, a crashed server, a machine that slept — nothing anywhere says
// so. Runs simply stay `queued` forever, the composer sits on "Agent is
// answering…", and the only way to find out is to notice that nothing has
// happened for a while.
//
// The fix is a heartbeat and a reading of it, deliberately in that order:
// this module never starts anything. Silently spawning a dispatcher from a
// page render would make an unbounded number of them (one per server, per
// render, per user) and hide the very failure it was meant to report.
import { getBrokerPool } from './db'

/** Beyond this, the dispatcher is not merely idle — it is gone. Comfortably
 * more than the poll interval (3s) plus any plausible pause, so a healthy
 * loop never trips it. */
const STALE_AFTER_MS = 60_000

export interface DispatcherHealth {
  /** When a tick last ran, or null if none ever has on this database. */
  lastTickAt: Date | null
  /** Milliseconds since that tick; null when there has never been one. */
  sinceLastTickMs: number | null
  /** Which process answered last — useful when more than one is running. */
  lastWorkerId: string | null
  /** No tick within the stale window (or none ever). */
  stale: boolean
  /** Runs sitting `queued` right now, across every workspace. */
  queueDepth: number
  /**
   * The combination that actually hurts: nothing is ticking AND work is
   * waiting. A stale dispatcher with an empty queue is a machine at rest;
   * a stale dispatcher with queued runs is a stuck product.
   */
  stalled: boolean
}

/**
 * Records that a tick just happened. Called from the tick route on every
 * poll — a single-row upsert against a one-row table, which is cheap enough
 * to run at the poll rate and is the only way a reader can distinguish
 * "idle" from "dead".
 */
export async function recordDispatcherTick(workerId: string): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `INSERT INTO dispatcher_heartbeat (id, last_tick_at, worker_id)
     VALUES (1, now(), $1)
     ON CONFLICT (id) DO UPDATE SET last_tick_at = now(), worker_id = EXCLUDED.worker_id`,
    [workerId],
  )
}

export async function getDispatcherHealth(): Promise<DispatcherHealth> {
  const pool = getBrokerPool()
  const [beat, queued] = await Promise.all([
    pool.query<{ last_tick_at: Date | null; worker_id: string | null }>(
      `SELECT last_tick_at, worker_id FROM dispatcher_heartbeat WHERE id = 1`,
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'`),
  ])

  const lastTickAt = beat.rows[0]?.last_tick_at ?? null
  const sinceLastTickMs = lastTickAt ? Date.now() - lastTickAt.getTime() : null
  const stale = sinceLastTickMs === null || sinceLastTickMs > STALE_AFTER_MS
  const queueDepth = Number(queued.rows[0]?.count ?? 0)

  return {
    lastTickAt,
    sinceLastTickMs,
    lastWorkerId: beat.rows[0]?.worker_id ?? null,
    stale,
    queueDepth,
    stalled: stale && queueDepth > 0,
  }
}
