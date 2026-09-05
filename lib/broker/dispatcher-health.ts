// R3.3 / B9.1 — is the dispatcher actually running, and on which machine?
//
// The dispatcher is one manually started process per machine
// (`scripts/run-dispatcher-loop.ts` polling `/api/dispatcher/tick`). When one
// stops — a closed terminal, a crashed server, a machine that slept —
// nothing anywhere says so. Runs simply stay `queued` forever, the composer
// sits on "Agent is answering…", and the only way to find out used to be
// noticing that nothing has happened for a while.
//
// Keyed by `host_id` (`lib/runtimes/host-id.ts`'s `currentHostId()`) rather
// than one fixed row: with host-scoped claiming (`runtime_profiles.host_id`,
// `lib/broker/runs.ts`'s `claimNextRun`), "is the dispatcher alive" stopped
// being one true/false answer the moment a second machine could dispatch —
// a single shared row could only ever report on whichever machine happened
// to write it last, silently hiding every other machine's dispatcher going
// dark. One row per machine, upserted on every tick from that machine, is
// what makes "is *this* named machine's dispatcher alive" answerable at all
// (feeds the Machines status view, B9.3).
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
  /** Runs sitting `queued` right now, across every workspace. Global, not
   * per-host — a run has no host of its own until it's claimed. */
  queueDepth: number
  /**
   * The combination that actually hurts: nothing is ticking AND work is
   * waiting. A stale dispatcher with an empty queue is a machine at rest;
   * a stale dispatcher with queued runs is a stuck product.
   */
  stalled: boolean
}

/** One machine's heartbeat row, without the workspace-wide queue numbers —
 * the shape `listDispatcherHeartbeats` returns for a bulk read, e.g. the
 * Machines status view (B9.3), which asks about many hosts at once and would
 * otherwise pay `queueDepth`'s query once per row for no reason. */
export interface HostHeartbeat {
  hostId: string
  lastTickAt: Date
  sinceLastTickMs: number
  stale: boolean
}

/**
 * Records that a tick just happened, for the machine that ran it. Called
 * from the tick route on every poll — one upsert keyed by `hostId`, cheap
 * enough to run at the poll rate and the only way a reader can distinguish
 * "this machine is idle" from "this machine is dead".
 */
export async function recordDispatcherTick(workerId: string, hostId: string): Promise<void> {
  const pool = getBrokerPool()
  await pool.query(
    `INSERT INTO dispatcher_heartbeat (host_id, last_tick_at, worker_id)
     VALUES ($1, now(), $2)
     ON CONFLICT (host_id) DO UPDATE SET last_tick_at = now(), worker_id = EXCLUDED.worker_id`,
    [hostId, workerId],
  )
}

/** One machine's health, by its `hostId` — what the Runtimes/Health pages
 * ask for the machine they're actually running on (`currentHostId()`). */
export async function getDispatcherHealth(hostId: string): Promise<DispatcherHealth> {
  const pool = getBrokerPool()
  const [beat, queued] = await Promise.all([
    pool.query<{ last_tick_at: Date | null; worker_id: string | null }>(
      `SELECT last_tick_at, worker_id FROM dispatcher_heartbeat WHERE host_id = $1`,
      [hostId],
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

/**
 * Every machine that has ever ticked, in one query — for a view that lists
 * several machines at once (the Machines section, B9.3) rather than asking
 * per-row and turning "how many machines" into an N+1 (D0).
 */
export async function listDispatcherHeartbeats(): Promise<HostHeartbeat[]> {
  const pool = getBrokerPool()
  const res = await pool.query<{ host_id: string; last_tick_at: Date; worker_id: string | null }>(
    `SELECT host_id, last_tick_at, worker_id FROM dispatcher_heartbeat`,
  )
  const now = Date.now()
  return res.rows.map((row) => {
    const sinceLastTickMs = now - row.last_tick_at.getTime()
    return {
      hostId: row.host_id,
      lastTickAt: row.last_tick_at,
      sinceLastTickMs,
      stale: sinceLastTickMs > STALE_AFTER_MS,
    }
  })
}
