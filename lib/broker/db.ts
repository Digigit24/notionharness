import { Pool } from 'pg'

// Shared small pool for the raw-pg-owned broker tables (runs/run_messages/
// run_usage — see AGENTS.md's D5 section). Kept deliberately small: this
// project's Postgres is a shared, small-tier Supabase instance with a real
// session-mode connection cap (~15, hit and confirmed live this session) —
// every teammate's dev server and one-off script competes for the same pool,
// alongside `lib/payload.ts`'s own pool (max 8) and `lib/auth.ts`'s
// (max 3) in this same process. 4 here keeps the three pools' combined
// worst case (4+8+3=15) at the shared instance's actual cap rather than
// over it — a prior 6 here, chosen without accounting for the auth pool at
// all, summed to 17 and kept crashing live even after the Payload pool was
// capped.
const POOL_MAX = 4

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
