// R12-P5.3 — the mutex around a shared bare clone, made true rather than
// merely commented.
//
// `manager.ts` used to say "the mutex is in-process by design", which is
// correct only while exactly one Node process ever touches a given bare
// clone. That stopped being true the moment this project ran a `npm start`
// server and a `scripts/run-dispatcher-loop.ts` poller side by side on one
// machine (both do, right now, in dev) — two processes, each with their own
// in-process `Map`, each confident nobody else was touching the same
// `<repo>.git` directory. A Postgres advisory lock is process-independent —
// any client holding the same 64-bit key, from any process on any host that
// can reach this database, serializes with any other — so it is the one
// mechanism that actually enforces the invariant the comment only asserted.
//
// SESSION-SCOPED, not `pg_advisory_xact_lock`, and the choice is deliberate
// rather than a default: the work being guarded (`git clone`/`fetch`/
// `worktree add`) is not a database write, so wrapping it in a `BEGIN … COMMIT`
// purely to get a transaction to hang the lock off would be a fake
// transaction invented to satisfy a locking API — a real footgun, because a
// stray failed statement on that same connection (there are none here, but
// the pattern invites them later) would abort the transaction and release
// the lock long before the git work is done. An explicit session lock,
// acquired and released by hand around exactly the operation it guards, says
// what it means. Both flavours release automatically if the holding
// connection dies mid-operation (a crashed worker, a killed process), which
// is the crash-safety property that actually matters here — so nothing is
// given up by not using the transaction-scoped variant.
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { getBrokerPool } from '@/lib/broker/db'
import { raise } from '@/lib/failures'

/**
 * A stable 64-bit signed key for `pg_advisory_lock`, derived from the bare
 * clone's own filesystem path. Two different repositories must never share a
 * key (that would serialize unrelated worktrees against each other for no
 * reason) and the same repository must always produce the same key (or the
 * lock would not lock anything) — a content hash gives both for free, with
 * no coordination table to keep in sync.
 *
 * `pg_advisory_lock(bigint)` takes a SIGNED 64-bit integer. `asIntN(64, …)`
 * reinterprets the top 8 bytes of a SHA-256 digest (an unsigned 64-bit
 * value) as that signed domain — the collision odds of two real repository
 * paths landing on the same key are the collision odds of SHA-256 itself.
 */
export function lockKeyFor(path: string): bigint {
  const digest = createHash('sha256').update(path).digest()
  return BigInt.asIntN(64, digest.readBigUInt64BE(0))
}

/**
 * Runs `work` while holding the advisory lock keyed on `path`, across every
 * process talking to this database.
 *
 * A single connection is checked out of the broker's own (deliberately
 * small, connection-capped) pool for the full duration of `work` — session
 * advisory locks are tied to the connection that took them, so the same
 * client must issue both the lock and the unlock. That is the real cost of
 * this mechanism: a slow `git clone` holds one of the broker pool's few
 * connections for as long as it runs. Accepted rather than worked around,
 * because the caller (`RunWorktreeManager`) already serializes same-process
 * callers through an in-process queue first (see `withLock` there) — only
 * ONE connection is ever held per process for this at a time, not one per
 * concurrent caller — and `getBrokerPool()`'s own `connectionTimeoutMillis`
 * turns a genuinely exhausted pool into a clear, fast, typed failure
 * (`db_unavailable`) rather than a silent hang, which is exactly the
 * behaviour P5.4's chaos script proves.
 */
export async function withRepoLock<T>(path: string, work: () => Promise<T>, pool: Pool = getBrokerPool()): Promise<T> {
  const key = lockKeyFor(path).toString()
  let client
  try {
    client = await pool.connect()
  } catch (err) {
    raise('db_unavailable', 'Could not reach the database to lock this repository.', {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key])
    try {
      return await work()
    } finally {
      // Best-effort: the connection is about to be released back to the
      // pool either way, and a session-scoped advisory lock is also freed
      // the moment its holding connection closes — so a failed unlock here
      // cannot leak the lock past this connection's next use elsewhere, it
      // can only (rarely) leave it held a little longer than necessary.
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {})
    }
  } finally {
    client.release()
  }
}
