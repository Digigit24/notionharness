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
  const sql = [
    fs.readFileSync(path.join(import.meta.dirname, '0001_runs_run_messages_run_usage.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0002_run_page_context.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0003_run_prompt.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0004_runs_task_agent_active_uidx_null_safe.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0005_run_suggestion_status.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0006_run_dismissed_at.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0007_sessions_and_worktrees.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0008_dispatcher_heartbeat.sql'), 'utf8'),
    fs.readFileSync(path.join(import.meta.dirname, '0009_teams.sql'), 'utf8'),
  ].join('\n')

  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 1 })
  try {
    await pool.query(sql)
    console.log(
      'Broker schema applied: runs, run_messages, run_usage, run page context, NULL-safe active-run index, run suggestion status, run dismissed_at, sessions + worktrees, dispatcher heartbeat, teams.',
    )
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
