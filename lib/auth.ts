import { betterAuth } from 'better-auth'
import { Pool } from 'pg'

// Better Auth owns its own tables (user/session/account/verification) in the
// same Postgres database Payload uses — separate schema, no shared tables, so
// this never touches Payload's own `users` collection or its admin-panel auth.
// See lib/current-user.ts for how a session is mapped to a Payload `users` doc.
//
// Exported so other server-only code (e.g. the mention-user-list route) can
// query Better Auth's own tables directly without opening a second pool
// against the same connection-capped Postgres instance.
//
// Cached on `globalThis`, not a bare module-level `const`: a plain `const`
// re-executes `new Pool(...)` every time this module is re-evaluated, which
// Next.js dev-mode Fast Refresh does on every edit to this file (or anything
// that imports it) — each reset leaked the previous pool's connections
// (nothing ever called `.end()` on it) and, combined with `lib/broker/db.ts`
// having the exact same bug, was the real cause of EMAXCONNSESSION recurring
// across a dev session regardless of any single pool's `max`. `globalThis`
// survives module re-execution in Next dev, matching `lib/payload.ts`'s own
// client cache.
declare global {
  var _notionforgeAuthPool: Pool | undefined
  var _notionforgeAuth: ReturnType<typeof betterAuth> | undefined
}

export const authPool =
  global._notionforgeAuthPool ??
  (global._notionforgeAuthPool = new Pool({
    connectionString: process.env.DATABASE_URI || '',
    // Kept small deliberately: the shared dev Postgres instance has a low
    // session-mode connection cap, and Payload's own pool already competes
    // for it — no reason for auth's low-traffic queries to claim more.
    max: 3,
  }))

export const auth =
  global._notionforgeAuth ??
  (global._notionforgeAuth = betterAuth({
    database: authPool,
    secret: process.env.BETTER_AUTH_SECRET || '',
    baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
    trustedOrigins: [
      'http://localhost:3000',
      'http://digitech.tail7572d2.ts.net:3000',
      // Playwright's dev server falls back to 3001 whenever 3000 is already
      // held by a manually-run `npm start`/`npm run dev` (see e2e/ — this
      // repo's DB is shared, so E2E runs alongside manual testing rather
      // than replacing it).
      'http://localhost:3001',
    ],
    emailAndPassword: {
      enabled: true,
    },
  }))
