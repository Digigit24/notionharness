// P5.4 e2e probe — verify the runtime_profile binary actually exists before
// we sink a turn into it. Pulls all runtime profiles, the agent+workspace
// state, and a couple of prerequisite checks (whether dispatcher's
// `scripts/run-dispatcher-loop.ts` is currently polling, to avoid
// double-tick contention while we drive ticks manually).

import nextEnv from '@next/env'
import { Pool } from 'pg'
import * as fs from 'node:fs'
import * as path from 'node:path'

nextEnv.loadEnvConfig(process.cwd())

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URI || '', max: 2 })
  try {
    // 1. Runtime profiles
    const rp = await pool.query(
      `SELECT * FROM runtime_profiles ORDER BY id ASC`
    )
    console.log(`runtime_profiles(${rp.rowCount}):`)
    rp.rows.forEach(r => {
      const cmdName = r.command_name
      const exists = cmdName ? (fs.existsSync(cmdName) ? 'EXISTS' : 'MISSING') : 'NO CMD'
      console.log(`  id=${r.id} name="${r.name}" commandName=${cmdName} fixedArgs=${JSON.stringify(r.fixed_args)} [${exists}]`)
    })

    // 2. Agents (with their permission modes)
    const agents = await pool.query(
      `SELECT id, name, permission_mode, permission_timeout_ms, runtime_profile_id, enabled, workspace_id
       FROM agents ORDER BY id ASC`
    )
    console.log(`\nagents(${agents.rowCount}):`)
    agents.rows.forEach(r => console.log(`  ${JSON.stringify(r)}`))

    // 3. Tasks with workspace_id
    const tasks = await pool.query(
      `SELECT id, workspace_id, title, status FROM tasks ORDER BY id ASC LIMIT 5`
    )
    console.log(`\ntasks(${tasks.rowCount}):`)
    tasks.rows.forEach(r => console.log(`  ${JSON.stringify(r)}`))

    // 4. Recent runs
    const runs = await pool.query(
      `SELECT id, status, task_id, agent_id, accountable_user, page_id, run_token, prompt,
              created_at, updated_at
       FROM runs ORDER BY id DESC LIMIT 5`
    )
    console.log(`\nruns(${runs.rowCount}):`)
    runs.rows.forEach(r => console.log(`  ${JSON.stringify(r)}`))

    // 5. Open sessions for better-auth to spot any active poller cookies
    const sessions = await pool.query(
      `SELECT userid, expires_at, token FROM session ORDER BY expires_at DESC LIMIT 3`
    )
    console.log(`\nbetter-auth sessions(${sessions.rowCount}):`)
    sessions.rows.forEach(r => console.log(`  ${JSON.stringify(r)}`))
  } finally {
    await pool.end()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
