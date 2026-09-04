import { Pool } from 'pg'

// Shared small pool for the raw-pg-owned broker tables (runs/run_messages/
// run_usage — see AGENTS.md's D5 section). Kept deliberately small: this
// project's Postgres is a shared, small-tier Supabase instance with a real
// session-mode connection cap (~15, hit and confirmed live this session) —
// every teammate's dev server and one-off script competes for the same pool,
// alongside `lib/payload.ts`'s own pool (now max 7) and `lib/auth.ts`'s
// (now max 2) in this same process. A prior 6 here, chosen without
// accounting for the auth pool at all, summed to 17 and kept crashing live
// even after the Payload pool was capped — that was fixed by landing the
// three pools' combined `max` (4+8+3) exactly ON the instance's real cap of
// 15, which stopped the crashing but turned out to leave zero headroom:
// confirmed live in a later session — all 15 slots sat idle-but-held by
// this app's own warm pools, and a single extra burst (one more page load,
// one ad-hoc script) immediately timed out waiting for a connection with no
// error until `connectionTimeoutMillis` was added below. 3 here (down from
// 4) + the sibling pools' own trims leaves 3 connections of real headroom
// (12 total) instead of 0.
const POOL_MAX = 3

// A plain module-level `let pool` resets to `null` every time this module is
// re-evaluated — which Next.js dev-mode Fast Refresh does on every edit to
// this file, or any file that transitively imports it. Each reset created a
// BRAND NEW `Pool` (up to `POOL_MAX` more live connections) while the
// previous instance's connections were never closed (nothing calls
// `closeBrokerPool()` on HMR) — a real, compounding connection leak that
// explains why EMAXCONNSESSION kept recurring across a dev session even with
// individually reasonable `max` values. `globalThis` survives module
// re-execution in Next dev (same reason `lib/payload.ts`'s client cache
// uses it), so cache the pool there instead of a bare module variable.
declare global {
  var _notionforgeBrokerPool: Pool | null | undefined
}

export function getBrokerPool(): Pool {
  if (!global._notionforgeBrokerPool) {
    global._notionforgeBrokerPool = new Pool({
      connectionString: process.env.DATABASE_URI || '',
      max: POOL_MAX,
      // Without this, a query that can't get a connection because this pool
      // (or a sibling one — lib/auth.ts, payload.config.ts) is at `max`
      // waits forever with node-postgres's default (no timeout) — silently,
      // no thrown error. Confirmed live: connections sat at 15/15 (this
      // instance's real cap) with this pool's own appendRunEvent queries
      // actively contending. Failing loud after 8s turns a silent hang
      // into a visible, debuggable error instead of a blank page.
      connectionTimeoutMillis: 8_000,
    })
  }
  return global._notionforgeBrokerPool
}

export async function closeBrokerPool(): Promise<void> {
  if (global._notionforgeBrokerPool) {
    await global._notionforgeBrokerPool.end()
    global._notionforgeBrokerPool = null
  }
}
