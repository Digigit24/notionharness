import { Pool } from 'pg'

// Shared small pool for the raw-pg-owned broker tables (runs/run_messages/
// run_usage — see AGENTS.md's D5 section). Kept deliberately small: this
// project's Postgres is a shared, small-tier Supabase instance with a real
// session-mode connection cap (~15, hit and confirmed live this session) —
// every teammate's dev server and one-off script competes for the same pool.
let pool: Pool | null = null

export function getBrokerPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URI || '',
      max: 3,
    })
  }
  return pool
}

export async function closeBrokerPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
