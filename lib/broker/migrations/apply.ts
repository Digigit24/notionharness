import fs from 'node:fs'
import path from 'node:path'
import nextEnv from '@next/env'
import { Pool } from 'pg'

nextEnv.loadEnvConfig(process.cwd())

// One-off apply script for the raw-pg broker schema — NOT `payload migrate`.
// Payload has no awareness of runs/run_messages/run_usage and must stay that
// way (AGENTS.md D5). Run manually: `npx tsx lib/broker/migrations/apply.ts`.
// Safe to re-run — every statement in the .sql file is idempotent.
async function main() {
  const sqlPath = path.join(import.meta.dirname, '0001_runs_run_messages_run_usage.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')

  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(sql)
    console.log('Broker schema applied: runs, run_messages, run_usage.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
