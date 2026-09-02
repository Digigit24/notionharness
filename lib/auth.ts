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
export const authPool = new Pool({
  connectionString: process.env.DATABASE_URI || '',
  // Kept small deliberately: the shared dev Postgres instance has a low
  // session-mode connection cap, and Payload's own pool already competes
  // for it — no reason for auth's low-traffic queries to claim more.
  max: 3,
})

export const auth = betterAuth({
  database: authPool,
  secret: process.env.BETTER_AUTH_SECRET || '',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  trustedOrigins: [
    'http://localhost:3000',
    'http://digitech.tail7572d2.ts.net:3000',
  ],
  emailAndPassword: {
    enabled: true,
  },
})
